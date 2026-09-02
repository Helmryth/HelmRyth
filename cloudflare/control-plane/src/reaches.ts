import {
  CloudflareAPI,
  CloudflareAPIError,
  type CloudflareDNSRecord,
  type CloudflareFetch,
  type CloudflareTunnel,
} from "./cloudflare-api";
import type { RegistryConfig } from "./config";
import { errorResponse, HTTPError, json } from "./http";
import { requireNode } from "./nodes";

type ReachStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

interface ReachRow {
  node_id: string;
  hostname: string;
  tunnel_name: string;
  tunnel_id: string | null;
  dns_record_id: string | null;
  status: ReachStatus;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_reconciled_at: number | null;
  delete_requested_at: number | null;
  last_error_code: string | null;
  cleanup_attempts: number;
  last_cleanup_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ClaimedReach {
  leaseOwner: string;
  row: ReachRow;
}

const LEASE_MS = 60_000;
const REACH_ACTION_WINDOW_MS = 60 * 60 * 1_000;
const REACH_RECONCILE_LIMIT = 20;
const REACH_DELETE_LIMIT = 30;
// A cleanup can make at most ten external Cloudflare API calls when it must
// rediscover both provider IDs. Four concurrent candidates stay below the
// Workers Free plan's 50-external-subrequest ceiling and six-connection limit.
const CLEANUP_SWEEP_LIMIT = 4;
const CLEANUP_BACKOFF_1_MS = 5 * 60 * 1_000;
const CLEANUP_BACKOFF_2_MS = 15 * 60 * 1_000;
const CLEANUP_BACKOFF_3_MS = 60 * 60 * 1_000;
const CLEANUP_BACKOFF_4_MS = 6 * 60 * 60 * 1_000;
const CLEANUP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1_000;
const MANUAL_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

class ReachOperationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ReachOperationError";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Error values enter here directly from catch boundaries.
function errorCode(error: unknown): string {
  if (error instanceof CloudflareAPIError || error instanceof ReachOperationError) return error.code;
  return "reach_internal";
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reachJSON(row: ReachRow) {
  return {
    url: `https://${row.hostname}`,
    hostname: row.hostname,
    status: row.status,
    generation: row.generation,
    updatedAt: row.updated_at,
    lastReconciledAt: row.last_reconciled_at,
    lastErrorCode: row.last_error_code,
  };
}

async function reachRow(env: Env, nodeId: string): Promise<ReachRow | null> {
  return env.REGISTRY_DB.prepare(
    `SELECT node_id, hostname, tunnel_name, tunnel_id, dns_record_id,
            status, generation, lease_owner, lease_expires_at,
            last_reconciled_at, delete_requested_at, last_error_code,
            cleanup_attempts, last_cleanup_attempt_at, created_at, updated_at
       FROM node_reaches
      WHERE node_id = ?`,
  ).bind(nodeId).first<ReachRow>();
}

async function ensureReachRow(
  env: Env,
  nodeId: string,
  hostSuffix: string,
): Promise<ReachRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opaque = randomHex(16);
    const now = Date.now();
    await env.REGISTRY_DB.prepare(
      `INSERT OR IGNORE INTO node_reaches
        (node_id, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(nodeId, `r-${opaque}.${hostSuffix}`, `hry-r-${opaque}`, now, now).run();
    const row = await reachRow(env, nodeId);
    if (row) return row;
  }
  throw new ReachOperationError("reach_reservation_failed");
}

async function enforceReachRateLimit(
  env: Env,
  nodeId: string,
  action: "delete_reach" | "reconcile_reach",
): Promise<void> {
  const now = Date.now();
  const cutoff = now - REACH_ACTION_WINDOW_MS;
  const limit = action === "reconcile_reach" ? REACH_RECONCILE_LIMIT : REACH_DELETE_LIMIT;
  const result = await env.REGISTRY_DB.prepare(
    `INSERT INTO node_action_rate_limits
      (node_id, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(node_id, action) DO UPDATE SET
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
  ).bind(nodeId, action, now, now, cutoff, cutoff, cutoff, limit).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

async function claimReach(
  env: Env,
  row: ReachRow,
  nextStatus: "deleting" | "provisioning",
): Promise<ClaimedReach | null> {
  const now = Date.now();
  const leaseOwner = crypto.randomUUID();
  const deletingGuard = nextStatus === "provisioning" ? "AND status != 'deleting'" : "";
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE node_reaches
        SET status = ?, generation = generation + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?,
            delete_requested_at = CASE WHEN ? = 'deleting' THEN COALESCE(delete_requested_at, ?) ELSE NULL END,
            cleanup_attempts = CASE WHEN ? = 'deleting' THEN cleanup_attempts + 1 ELSE 0 END,
            last_cleanup_attempt_at = CASE WHEN ? = 'deleting' THEN ? ELSE NULL END,
            last_error_code = NULL
      WHERE node_id = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${deletingGuard}`,
  ).bind(
    nextStatus,
    leaseOwner,
    now + LEASE_MS,
    now,
    nextStatus,
    now,
    nextStatus,
    nextStatus,
    now,
    row.node_id,
    now,
  ).run();
  if (result.meta.changes === 0) return null;
  const claimed = await reachRow(env, row.node_id);
  if (!claimed || claimed.lease_owner !== leaseOwner) {
    throw new ReachOperationError("lease_lost");
  }
  return { leaseOwner, row: claimed };
}

async function updateClaimedResources(
  env: Env,
  claim: ClaimedReach,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE node_reaches
        SET tunnel_id = ?, dns_record_id = ?, updated_at = ?
      WHERE node_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    tunnelId,
    dnsRecordId,
    Date.now(),
    claim.row.node_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new ReachOperationError("lease_lost");
  claim.row.tunnel_id = tunnelId;
  claim.row.dns_record_id = dnsRecordId;
}

async function renewClaim(env: Env, claim: ClaimedReach): Promise<void> {
  const now = Date.now();
  const leaseExpiresAt = now + LEASE_MS;
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE node_reaches
        SET lease_expires_at = ?, updated_at = ?
      WHERE node_id = ? AND generation = ? AND lease_owner = ?
        AND lease_expires_at > ?`,
  ).bind(
    leaseExpiresAt,
    now,
    claim.row.node_id,
    claim.row.generation,
    claim.leaseOwner,
    now,
  ).run();
  if (result.meta.changes === 0) throw new ReachOperationError("lease_lost");
  claim.row.lease_expires_at = leaseExpiresAt;
}

async function withClaimLease<T>(
  env: Env,
  claim: ClaimedReach,
  operation: () => Promise<T>,
): Promise<T> {
  await renewClaim(env, claim);
  return operation();
}

function expectedTunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

function assertTunnelIdentity(
  claim: ClaimedReach,
  tunnelId: string,
  tunnel: { id: string; name: string },
): void {
  if (tunnel.id !== tunnelId || tunnel.name !== claim.row.tunnel_name) {
    throw new ReachOperationError("tunnel_identity_conflict");
  }
}

function assertDNSIdentity(
  claim: ClaimedReach,
  tunnelId: string,
  dnsRecordId: string,
  record: { content: string; id: string; name: string; proxied: boolean; type: string },
): void {
  if (
    record.id !== dnsRecordId
    || record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new ReachOperationError("dns_record_identity_conflict");
  }
}

async function finishClaim(
  env: Env,
  claim: ClaimedReach,
  status: "deleted" | "ready",
): Promise<ReachRow> {
  const now = Date.now();
  const result = await env.REGISTRY_DB.prepare(
    `UPDATE node_reaches
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_reconciled_at = ?, last_error_code = NULL, updated_at = ?
      WHERE node_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(status, now, now, claim.row.node_id, claim.row.generation, claim.leaseOwner).run();
  if (result.meta.changes === 0) throw new ReachOperationError("lease_lost");
  const row = await reachRow(env, claim.row.node_id);
  if (!row) throw new ReachOperationError("reach_state_missing");
  return row;
}

async function failClaim(
  env: Env,
  claim: ClaimedReach,
  code: string,
  preserveDeleting: boolean,
): Promise<void> {
  await env.REGISTRY_DB.prepare(
    `UPDATE node_reaches
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
      WHERE node_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    preserveDeleting ? "deleting" : "error",
    code.slice(0, 64),
    Date.now(),
    claim.row.node_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
}

function busyResponse(): Response {
  const response = errorResponse(409, "reach_busy");
  const headers = new Headers(response.headers);
  headers.set("retry-after", "2");
  return new Response(response.body, { status: response.status, headers });
}

async function reconcileDNSWriteResult(
  env: Env,
  claim: ClaimedReach,
  api: CloudflareAPI,
  tunnelId: string,
  expectedRecordId: string | null,
): Promise<CloudflareDNSRecord | null> {
  const records = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (records.length > 1) throw new ReachOperationError("dns_record_conflict");
  const record = records[0];
  if (!record) return null;
  if (expectedRecordId && record.id !== expectedRecordId) {
    throw new ReachOperationError("dns_record_conflict");
  }
  if (
    record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new ReachOperationError("dns_record_conflict");
  }
  return record;
}

async function verifiedTunnelForCleanup(
  env: Env,
  claim: ClaimedReach,
  api: CloudflareAPI,
  tunnelId: string,
): Promise<CloudflareTunnel | null> {
  const tunnel = await withClaimLease(env, claim, () => api.getTunnel(tunnelId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (named.length > 1) throw new ReachOperationError("tunnel_identity_conflict");
  if (!tunnel) {
    if (named.length !== 0) throw new ReachOperationError("tunnel_identity_conflict");
    return null;
  }
  assertTunnelIdentity(claim, tunnelId, tunnel);
  if (named.length !== 1 || named[0]?.id !== tunnelId) {
    throw new ReachOperationError("tunnel_identity_conflict");
  }
  return tunnel;
}

async function verifiedDNSForCleanup(
  env: Env,
  claim: ClaimedReach,
  api: CloudflareAPI,
  tunnelId: string,
  dnsRecordId: string,
): Promise<CloudflareDNSRecord | null> {
  const record = await withClaimLease(env, claim, () => api.getDNSRecord(dnsRecordId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (named.length > 1) throw new ReachOperationError("dns_record_identity_conflict");
  if (!record) {
    if (named.length !== 0) throw new ReachOperationError("dns_record_identity_conflict");
    return null;
  }
  assertDNSIdentity(claim, tunnelId, dnsRecordId, record);
  if (named.length !== 1 || named[0]?.id !== dnsRecordId) {
    throw new ReachOperationError("dns_record_identity_conflict");
  }
  return record;
}

async function rollbackCreatedResources(
  env: Env,
  claim: ClaimedReach,
  api: CloudflareAPI,
  state: {
    createdDNSRecord: boolean;
    createdTunnel: boolean;
    dnsMayReferenceTunnel: boolean;
    dnsRecordId: string | null;
    tunnelId: string | null;
  },
): Promise<{ dnsRecordId: string | null; tunnelId: string | null }> {
  let { dnsRecordId, tunnelId } = state;
  if (!state.createdDNSRecord && !state.createdTunnel) return { dnsRecordId, tunnelId };
  if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);

  if (state.createdDNSRecord && dnsRecordId && tunnelId) {
    const record = await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId);
    if (record) {
      await renewClaim(env, claim);
      await api.deleteDNSRecord(dnsRecordId);
    }
    dnsRecordId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  if (
    state.createdTunnel
    && tunnelId
    && (!state.dnsMayReferenceTunnel || (state.createdDNSRecord && !dnsRecordId))
  ) {
    // Re-fetch immediately before the destructive request. The stable name is
    // our provider-side identity fence; a renamed/repurposed tunnel is retained.
    const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
    if (tunnel) {
      await renewClaim(env, claim);
      await api.deleteTunnel(tunnelId);
    }
    tunnelId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  return { dnsRecordId, tunnelId };
}

async function reconcileClaim(
  env: Env,
  config: RegistryConfig,
  claim: ClaimedReach,
  fetcher: CloudflareFetch,
): Promise<{ connectorToken: string; row: ReachRow }> {
  const api = new CloudflareAPI(config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;
  let createdTunnel = false;
  let createdDNSRecord = false;
  let dnsMayReferenceTunnel = false;

  try {
    const tunnels = await withClaimLease(
      env,
      claim,
      () => api.listTunnels(claim.row.tunnel_name),
    );
    if (tunnels.length > 1) throw new ReachOperationError("tunnel_name_conflict");
    if (tunnels.length === 1) {
      if (tunnelId && tunnelId !== tunnels[0]?.id) {
        throw new ReachOperationError("tunnel_id_conflict");
      }
      tunnelId = tunnels[0]?.id ?? null;
    } else {
      try {
        const tunnel = await withClaimLease(
          env,
          claim,
          () => api.createTunnel(claim.row.tunnel_name),
        );
        tunnelId = tunnel.id;
        createdTunnel = true;
      } catch (createError) {
        // A timeout/network failure can arrive after Cloudflare committed the
        // POST. Reconcile by the stable opaque name instead of creating a
        // duplicate tunnel on the next request.
        let created: CloudflareTunnel[];
        try {
          created = await withClaimLease(
            env,
            claim,
            () => api.listTunnels(claim.row.tunnel_name),
          );
        } catch {
          throw createError;
        }
        if (created.length > 1) throw new ReachOperationError("tunnel_name_conflict");
        if (created.length === 0) throw createError;
        tunnelId = created[0]?.id ?? null;
      }
    }
    if (!tunnelId) throw new ReachOperationError("tunnel_missing");
    const activeTunnelId = tunnelId;
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);
    await withClaimLease(
      env,
      claim,
      () => api.configureTunnel(activeTunnelId, claim.row.hostname),
    );

    const target = expectedTunnelTarget(activeTunnelId);
    const records = await withClaimLease(
      env,
      claim,
      () => api.listDNSRecords(claim.row.hostname),
    );
    if (records.length > 1) throw new ReachOperationError("dns_record_conflict");
    const existing = records[0];
    if (existing) {
      if (existing.content.toLowerCase() !== target && existing.id !== dnsRecordId) {
        throw new ReachOperationError("dns_record_conflict");
      }
      dnsMayReferenceTunnel = existing.content.toLowerCase() === target;
      let record = existing;
      if (!existing.proxied || existing.content.toLowerCase() !== target) {
        dnsMayReferenceTunnel = true;
        try {
          record = await withClaimLease(
            env,
            claim,
            () => api.updateDNSRecord(existing.id, claim.row.hostname, activeTunnelId),
          );
        } catch (writeError) {
          try {
            const reconciled = await reconcileDNSWriteResult(
              env,
              claim,
              api,
              activeTunnelId,
              existing.id,
            );
            if (!reconciled) throw writeError;
            record = reconciled;
          } catch (reconcileError) {
            if (reconcileError instanceof ReachOperationError) throw reconcileError;
            throw writeError;
          }
        }
      }
      dnsRecordId = record.id;
    } else {
      dnsMayReferenceTunnel = true;
      try {
        const record = await withClaimLease(
          env,
          claim,
          () => api.createDNSRecord(claim.row.hostname, activeTunnelId),
        );
        dnsRecordId = record.id;
        createdDNSRecord = true;
      } catch (writeError) {
        try {
          const reconciled = await reconcileDNSWriteResult(
            env,
            claim,
            api,
            activeTunnelId,
            null,
          );
          if (!reconciled) {
            dnsMayReferenceTunnel = false;
            throw writeError;
          }
          // The write may have committed, but its response did not prove that
          // this request created the record. Adopt and retain it on later
          // failures instead of destructively guessing.
          dnsRecordId = reconciled.id;
        } catch (reconcileError) {
          if (reconcileError instanceof ReachOperationError) throw reconcileError;
          throw writeError;
        }
      }
    }
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);

    const connectorToken = await withClaimLease(
      env,
      claim,
      () => api.getConnectorToken(activeTunnelId),
    );
    const row = await finishClaim(env, claim, "ready");
    return { connectorToken, row };
  } catch (error) {
    let operationCode = errorCode(error);

    try {
      const rolledBack = await rollbackCreatedResources(env, claim, api, {
        createdDNSRecord,
        createdTunnel,
        dnsMayReferenceTunnel,
        dnsRecordId,
        tunnelId,
      });
      dnsRecordId = rolledBack.dnsRecordId;
      tunnelId = rolledBack.tunnelId;
    } catch (rollbackError) {
      // A stale request must stop immediately: it no longer owns either the
      // D1 generation or the provider resources that a successor may adopt.
      operationCode = errorCode(rollbackError);
    }
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, false);
    } catch {
      // The original redacted failure is the useful client-facing result.
    }
    throw new ReachOperationError(operationCode);
  }
}

async function deleteClaim(
  env: Env,
  config: RegistryConfig,
  claim: ClaimedReach,
  fetcher: CloudflareFetch,
): Promise<void> {
  const api = new CloudflareAPI(config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;

  try {
    if (!tunnelId) {
      const tunnels = await withClaimLease(
        env,
        claim,
        () => api.listTunnels(claim.row.tunnel_name),
      );
      if (tunnels.length > 1) throw new ReachOperationError("tunnel_name_conflict");
      tunnelId = tunnels[0]?.id ?? null;
      if (tunnelId) await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (!dnsRecordId) {
      const records = await withClaimLease(
        env,
        claim,
        () => api.listDNSRecords(claim.row.hostname),
      );
      if (records.length > 1) throw new ReachOperationError("dns_record_conflict");
      const record = records[0];
      if (record) {
        if (
          !tunnelId
          || record.type !== "CNAME"
          || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
          || !record.proxied
        ) {
          throw new ReachOperationError("dns_record_conflict");
        }
        dnsRecordId = record.id;
        await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      }
    }

    // Validate the complete resource set before the first delete. Persisted
    // provider IDs are only hints: the hostname/CNAME and stable tunnel name
    // must still agree, otherwise cleanup retains metadata for an operator.
    if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);
    const dnsRecord = dnsRecordId && tunnelId
      ? await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId)
      : null;
    if (dnsRecordId && !tunnelId) {
      throw new ReachOperationError("dns_record_identity_conflict");
    }

    if (dnsRecordId) {
      if (dnsRecord) {
        await renewClaim(env, claim);
        await api.deleteDNSRecord(dnsRecordId);
      }
      dnsRecordId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (tunnelId) {
      const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
      if (tunnel) {
        await renewClaim(env, claim);
        await api.deleteTunnel(tunnelId);
      }
      tunnelId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    await finishClaim(env, claim, "deleted");
  } catch (error) {
    const operationCode = errorCode(error);
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, true);
    } catch {
      // Keep the original redacted error code.
    }
    throw new ReachOperationError(operationCode);
  }
}

export async function getManagedReach(request: Request, env: Env): Promise<Response> {
  const node = await requireNode(request, env);
  const row = await reachRow(env, node.node_id);
  if (!row || row.status === "deleted") return json({ reach: null });
  return json({ reach: reachJSON(row) });
}

export async function provisionManagedReach(
  request: Request,
  env: Env,
  config: RegistryConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const node = await requireNode(request, env);
  await enforceReachRateLimit(env, node.node_id, "reconcile_reach");
  const row = await ensureReachRow(
    env,
    node.node_id,
    config.cloudflare.reachHostSuffix,
  );
  const claim = await claimReach(env, row, "provisioning");
  if (!claim) return busyResponse();

  try {
    const result = await reconcileClaim(env, config, claim, fetcher);
    return json({ reach: reachJSON(result.row), connectorToken: result.connectorToken });
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed reach reconcile failed",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(502, "reach_unavailable");
  }
}

export async function deleteManagedReach(
  request: Request,
  env: Env,
  config: RegistryConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const node = await requireNode(request, env);
  const row = await reachRow(env, node.node_id);
  if (!row || row.status === "deleted") {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  await enforceReachRateLimit(env, node.node_id, "delete_reach");
  const claim = await claimReach(env, row, "deleting");
  if (!claim) return busyResponse();

  try {
    await deleteClaim(env, config, claim, fetcher);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed reach cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(503, "reach_cleanup_pending");
  }
}

export async function cleanupReachForNode(
  env: Env,
  config: RegistryConfig,
  nodeId: string,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<void> {
  const row = await reachRow(env, nodeId);
  if (!row || row.status === "deleted") return;
  const claim = await claimReach(env, row, "deleting");
  if (!claim) return;
  try {
    await deleteClaim(env, config, claim, fetcher);
  } catch (error) {
    console.error(JSON.stringify({
      message: "revoked node reach cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
  }
}

export async function sweepManagedReachCleanup(
  env: Env,
  config: RegistryConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<number> {
  const now = Date.now();
  const candidates = await env.REGISTRY_DB.prepare(
    `SELECT e.node_id, e.cleanup_attempts, e.delete_requested_at, e.last_error_code
       FROM node_reaches e
       LEFT JOIN nodes i ON i.id = e.node_id
      WHERE e.status != 'deleted'
        AND (
          e.status = 'deleting'
          OR i.revoked_at IS NOT NULL
          OR i.id IS NULL
        )
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
        AND (
          e.cleanup_attempts = 0
          OR e.last_cleanup_attempt_at IS NULL
          OR e.last_cleanup_attempt_at <= CASE
            WHEN e.cleanup_attempts = 1 THEN ?
            WHEN e.cleanup_attempts = 2 THEN ?
            WHEN e.cleanup_attempts = 3 THEN ?
            WHEN e.cleanup_attempts = 4 THEN ?
            ELSE ?
          END
        )
      ORDER BY COALESCE(e.delete_requested_at, e.last_cleanup_attempt_at, e.updated_at) ASC,
               e.node_id ASC
      LIMIT ?`,
  ).bind(
    now,
    now - CLEANUP_BACKOFF_1_MS,
    now - CLEANUP_BACKOFF_2_MS,
    now - CLEANUP_BACKOFF_3_MS,
    now - CLEANUP_BACKOFF_4_MS,
    now - CLEANUP_BACKOFF_MAX_MS,
    CLEANUP_SWEEP_LIMIT,
  ).all<{
    cleanup_attempts: number;
    delete_requested_at: number | null;
    node_id: string;
    last_error_code: string | null;
  }>();

  const staleCandidates = candidates.results.filter((candidate) => (
    candidate.delete_requested_at !== null
    && candidate.delete_requested_at <= now - MANUAL_CLEANUP_THRESHOLD_MS
  ));
  if (staleCandidates.length > 0) {
    console.error(JSON.stringify({
      message: "managed reach cleanup requires operator attention",
      requestId,
      staleCandidateCount: staleCandidates.length,
      maxCleanupAttempts: Math.max(...staleCandidates.map((candidate) => candidate.cleanup_attempts)),
      errorCodes: [...new Set(staleCandidates.map((candidate) => (
        candidate.last_error_code ?? "reach_cleanup_pending"
      )))].sort(),
    }));
  }

  await Promise.all(candidates.results.map(async (candidate) => {
    try {
      await cleanupReachForNode(
        env,
        config,
        candidate.node_id,
        fetcher,
        requestId,
      );
    } catch {
      console.error(JSON.stringify({
        message: "managed reach cleanup candidate failed",
        requestId,
        errorCode: "reach_internal",
      }));
    }
  }));
  return candidates.results.length;
}
