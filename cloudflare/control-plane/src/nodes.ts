import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

import type { RegistryAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json, readBoundedJSON } from "./http";

interface NodeRow {
  id: string;
  client_instance_id: string;
  display_name: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

interface OwnedNodeRow extends NodeRow {
  revoked_at: number | null;
}

interface NodeCredentialRow {
  node_id: string;
  lookup_id: string;
  secret_hash: string;
  display_name: string;
  client_instance_id: string;
  platform: "darwin" | "windows" | "linux";
  app_version: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  expires_at: number;
}

function printableString(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine((value) => {
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point === undefined || point < 32 || point === 127) return false;
    }
    return true;
  });
}

const printableName = printableString(80);
const printableVersion = printableString(64);

const createNodeSchema = z.strictObject({
  name: printableName,
  clientInstanceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  platform: z.enum(["darwin", "windows", "linux"]),
  appVersion: printableVersion.optional(),
});

const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NODE_CREDENTIAL = /^hry_node_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const NODE_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const CREATION_RATE_WINDOW_MS = 60 * 60 * 1_000;
const CREATION_RATE_MAX_ATTEMPTS = 100;

function nodeJSON(row: NodeRow) {
  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.display_name,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function newCredential(createdAt: number) {
  const lookupId = base64URL(randomBytes(16));
  const secret = base64URL(randomBytes(32));
  const raw = `hry_node_${lookupId}.${secret}`;
  return {
    lookupId,
    raw,
    secretHash: await sha256(raw),
    expiresAt: createdAt + NODE_CREDENTIAL_TTL_MS,
  };
}

async function requireAccount(request: Request, auth: RegistryAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

async function enforceCreationRateLimit(ownerUserId: string, env: Env): Promise<void> {
  const now = Date.now();
  const cutoff = now - CREATION_RATE_WINDOW_MS;
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO registry_action_rate_limits
      (user_id, action, window_started_at, attempts, updated_at)
     VALUES (?, 'create_node', ?, 1, ?)
     ON CONFLICT(user_id, action) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(
    ownerUserId,
    now,
    now,
    cutoff,
    cutoff,
    cutoff,
    CREATION_RATE_MAX_ATTEMPTS,
  ).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

export async function listNodes(request: Request, env: Env, auth: RegistryAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  const result = await env.REGISTRY_DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM nodes
      WHERE owner_user_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 100`,
  ).bind(session.user.id).all<NodeRow>();
  return json({ nodes: result.results.map(nodeJSON) });
}

export async function createNode(request: Request, env: Env, auth: RegistryAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  await enforceCreationRateLimit(session.user.id, env);
  const parsed = createNodeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const nodeId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.REGISTRY_DB.batch([
      env.REGISTRY_DB.prepare(
        `INSERT INTO nodes
          (id, owner_user_id, client_instance_id, display_name, platform, app_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        nodeId,
        session.user.id,
        parsed.data.clientInstanceId,
        parsed.data.name,
        parsed.data.platform,
        parsed.data.appVersion ?? null,
        now,
        now,
      ),
      env.REGISTRY_DB.prepare(
        `INSERT INTO node_credentials
          (id, node_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(credentialId, nodeId, credential.lookupId, credential.secretHash, now, credential.expiresAt),
    ]);
  } catch (error) {
    if (error instanceof Error && /active_node_limit/i.test(error.message)) {
      throw new HTTPError(409, "node_limit_reached");
    }
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HTTPError(409, "node_exists");
    }
    throw error;
  }

  return json({
    node: {
      id: nodeId,
      clientInstanceId: parsed.data.clientInstanceId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    },
    credential: credential.raw,
    credentialExpiresAt: credential.expiresAt,
  }, 201);
}

async function ownedActiveNode(id: string, ownerUserId: string, env: Env) {
  if (!NODE_ID.test(id)) return null;
  return env.REGISTRY_DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at
       FROM nodes
      WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
  ).bind(id, ownerUserId).first<NodeRow>();
}

async function ownedNode(id: string, ownerUserId: string, env: Env) {
  if (!NODE_ID.test(id)) return null;
  return env.REGISTRY_DB.prepare(
    `SELECT id, client_instance_id, display_name, platform, app_version,
            created_at, updated_at, last_seen_at, revoked_at
       FROM nodes
      WHERE id = ? AND owner_user_id = ?`,
  ).bind(id, ownerUserId).first<OwnedNodeRow>();
}

export async function rotateNodeCredential(
  request: Request,
  nodeId: string,
  env: Env,
  auth: RegistryAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const node = await ownedActiveNode(nodeId, session.user.id, env);
  if (!node) throw new HTTPError(404, "not_found");

  const now = Date.now();
  const credential = await newCredential(now);
  try {
    await env.REGISTRY_DB.batch([
      env.REGISTRY_DB.prepare(
        `UPDATE nodes
            SET updated_at = ?, last_rotation_at = ?
          WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      ).bind(now, now, nodeId, session.user.id),
      env.REGISTRY_DB.prepare(
        `UPDATE node_credentials
            SET revoked_at = ?
          WHERE node_id = ? AND revoked_at IS NULL`,
      ).bind(now, nodeId),
      env.REGISTRY_DB.prepare(
        `INSERT INTO node_credentials
          (id, node_id, lookup_id, secret_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        nodeId,
        credential.lookupId,
        credential.secretHash,
        now,
        credential.expiresAt,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error && /credential_rotation_rate_limited/i.test(error.message)) {
      throw new HTTPError(429, "credential_rotation_rate_limited");
    }
    if (error instanceof Error && /credential_rotation_conflict/i.test(error.message)) {
      throw new HTTPError(409, "credential_rotation_conflict");
    }
    throw error;
  }
  return json({ credential: credential.raw, createdAt: now, credentialExpiresAt: credential.expiresAt }, 201);
}

export async function revokeNode(
  request: Request,
  nodeId: string,
  env: Env,
  auth: RegistryAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const node = await ownedNode(nodeId, session.user.id, env);
  if (!node) throw new HTTPError(404, "not_found");

  if (node.revoked_at === null) {
    const now = Date.now();
    await env.REGISTRY_DB.batch([
      env.REGISTRY_DB.prepare("UPDATE nodes SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(now, now, nodeId),
      env.REGISTRY_DB.prepare(
        "UPDATE node_credentials SET revoked_at = ? WHERE node_id = ? AND revoked_at IS NULL",
      ).bind(now, nodeId),
    ]);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function authenticateNode(request: Request, env: Env): Promise<NodeCredentialRow | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const parsed = bearer?.match(NODE_CREDENTIAL);
  if (!bearer || !parsed) return null;

  const row = await env.REGISTRY_DB.prepare(
    `SELECT c.node_id, c.lookup_id, c.secret_hash, c.expires_at,
            i.display_name, i.client_instance_id, i.platform, i.app_version,
            i.created_at, i.updated_at, i.last_seen_at
       FROM node_credentials c
       JOIN nodes i ON i.id = c.node_id
      WHERE c.lookup_id = ?
        AND c.revoked_at IS NULL
        AND c.expires_at > ?
        AND i.revoked_at IS NULL`,
  ).bind(parsed[1], Date.now()).first<NodeCredentialRow>();
  if (!row) return null;

  const expected = fromHex(row.secret_hash);
  if (!expected) return null;
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)));
  if (!timingSafeEqual(actual, expected)) return null;
  return row;
}

export async function requireNode(
  request: Request,
  env: Env,
): Promise<NodeCredentialRow> {
  const node = await authenticateNode(request, env);
  if (!node) throw new HTTPError(401, "unauthorized");

  const now = Date.now();
  await env.REGISTRY_DB.batch([
    env.REGISTRY_DB.prepare(
      `UPDATE node_credentials
          SET last_used_at = ?
        WHERE lookup_id = ? AND revoked_at IS NULL`,
    ).bind(now, node.lookup_id),
    env.REGISTRY_DB.prepare(
      `UPDATE nodes
          SET last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
    ).bind(now, node.node_id),
  ]);
  node.last_seen_at = now;
  return node;
}

export async function nodeSelf(request: Request, env: Env): Promise<Response> {
  const node = await requireNode(request, env);
  return json({
    node: {
      id: node.node_id,
      clientInstanceId: node.client_instance_id,
      name: node.display_name,
      platform: node.platform,
      appVersion: node.app_version,
      createdAt: node.created_at,
      updatedAt: node.updated_at,
      lastSeenAt: node.last_seen_at,
    },
    credentialExpiresAt: node.expires_at,
  });
}
