import type { WebhookCredential } from "./webhooks.js";
import { z } from "zod";

export const WEBHOOK_CREDENTIALS_KEY = "helmryth.webhook-credentials.v1";
const LEGACY_WEBHOOK_CREDENTIALS_KEY = "omb-webhook-credentials";

type Store = (
  Pick<Storage, "getItem" | "setItem">
  & Partial<Pick<Storage, "removeItem">>
) | undefined;

export interface CachedWebhookCredential {
  credential: WebhookCredential;
  credentialVersion: number;
}

export interface CachedWebhookCredentials {
  [webhookId: string]: CachedWebhookCredential;
}

export interface WebhookCredentialVersions {
  [webhookId: string]: number;
}

export interface DeletedWebhookCredentials {
  [webhookId: string]: boolean;
}

export interface WebhookCredentialCache {
  credentials: CachedWebhookCredentials;
  versions: WebhookCredentialVersions;
  deleted: DeletedWebhookCredentials;
}

export interface WebhookCredentialInventory {
  [webhookId: string]: WebhookCredential;
}

export interface WebhookCredentialVersion {
  id: string;
  credentialVersion: number;
}

const webhookCredentialSchema = z.object({
  endpointUrl: z.string().min(1),
  secret: z.string().min(1),
  idempotencyKey: z.string().min(1),
  url: z.string().min(1).optional(),
}).transform(({ url: _url, ...credential }) => credential);

const cachedCredentialSchema = z.object({
  credential: webhookCredentialSchema,
  credentialVersion: z.number().int().positive(),
});

const legacyCacheDocumentSchema = z.object({
  credentials: z.record(z.string(), cachedCredentialSchema),
  versions: z.record(z.string(), z.number().int().nonnegative()),
  deleted: z.record(z.string(), z.boolean()),
}).strict();

const persistedCacheDocumentSchema = z.object({
  versions: z.record(z.string(), z.number().int().nonnegative()),
  deleted: z.record(z.string(), z.boolean()),
}).strict();

const legacyDocumentSchema = z.record(z.string(), z.json());

type PersistedWebhookCredentialCache = z.output<typeof persistedCacheDocumentSchema>;

const ephemeralCredentials = new WeakMap<NonNullable<Store>, CachedWebhookCredentials>();
let fallbackEphemeralCredentials: CachedWebhookCredentials = {};

function emptyCache(): WebhookCredentialCache {
  return { credentials: {}, versions: {}, deleted: {} };
}

function emptyPersistedCache(): PersistedWebhookCredentialCache {
  return { versions: {}, deleted: {} };
}

function credentialBucket(store: Store): CachedWebhookCredentials {
  if (!store) return fallbackEphemeralCredentials;
  const existing = ephemeralCredentials.get(store);
  if (existing) return existing;
  const created: CachedWebhookCredentials = {};
  ephemeralCredentials.set(store, created);
  return created;
}

function persist(store: Store, cache: WebhookCredentialCache): void {
  try {
    store?.setItem(WEBHOOK_CREDENTIALS_KEY, JSON.stringify({
      versions: cache.versions,
      deleted: cache.deleted,
    } satisfies PersistedWebhookCredentialCache));
  } catch {
    // Storage is best-effort. The in-memory reveal remains usable in the
    // mounted panel even when browser storage is unavailable.
  }
}

function sanitizeLegacyCacheDocument(value: z.output<typeof legacyCacheDocumentSchema>): PersistedWebhookCredentialCache {
  const cache = emptyPersistedCache();
  for (const [webhookId, entry] of Object.entries(value.credentials)) {
    cache.versions[webhookId] = Math.max(
      value.versions[webhookId] ?? 0,
      entry.credentialVersion,
    );
  }
  for (const [webhookId, version] of Object.entries(value.versions)) {
    cache.versions[webhookId] = Math.max(cache.versions[webhookId] ?? 0, version);
  }
  cache.deleted = { ...value.deleted };
  return cache;
}

function sanitizeLegacyDocument(value: z.output<typeof legacyDocumentSchema>): PersistedWebhookCredentialCache {
  const cache = emptyPersistedCache();
  for (const [webhookId, candidate] of Object.entries(value)) {
    const credential = webhookCredentialSchema.safeParse(candidate);
    if (!credential.success) continue;
    cache.versions[webhookId] = 1;
  }
  return cache;
}

function mergeEphemeralCredentials(
  store: Store,
  persisted: PersistedWebhookCredentialCache,
): WebhookCredentialCache {
  const credentials = credentialBucket(store);
  const cache = emptyCache();
  cache.versions = { ...persisted.versions };
  cache.deleted = { ...persisted.deleted };
  for (const [webhookId, entry] of Object.entries(credentials)) {
    if (cache.deleted[webhookId]) {
      delete credentials[webhookId];
      continue;
    }
    const floor = persisted.versions[webhookId] ?? 0;
    cache.versions[webhookId] = Math.max(cache.versions[webhookId] ?? 0, entry.credentialVersion);
    if (entry.credentialVersion < floor) {
      delete credentials[webhookId];
      continue;
    }
    cache.credentials[webhookId] = entry;
  }
  return cache;
}

/** Load the credential plus its non-secret generation watermark. The
 * watermark makes out-of-order rotate responses unable to resurrect an old
 * plaintext secret after a newer SSE event or deletion. Only the watermark
 * survives durable renderer storage; the one-time credential remains in
 * renderer memory. */
export function loadWebhookCredentialCache(store: Store): WebhookCredentialCache {
  try {
    const canonical = store?.getItem(WEBHOOK_CREDENTIALS_KEY);
    const legacy = canonical === null
      ? store?.getItem(LEGACY_WEBHOOK_CREDENTIALS_KEY)
      : null;
    const raw = canonical ?? legacy;
    if (!raw) return mergeEphemeralCredentials(store, emptyPersistedCache());
    const decoded = JSON.parse(raw);
    const persisted = persistedCacheDocumentSchema.safeParse(decoded);
    if (persisted.success) return mergeEphemeralCredentials(store, persisted.data);
    const legacyCache = legacyCacheDocumentSchema.safeParse(decoded);
    if (legacyCache.success) {
      const migrated = sanitizeLegacyCacheDocument(legacyCache.data);
      persist(store, { ...emptyCache(), ...migrated });
      if (legacy !== null) store?.removeItem?.(LEGACY_WEBHOOK_CREDENTIALS_KEY);
      return mergeEphemeralCredentials(store, migrated);
    }
    const old = legacyDocumentSchema.safeParse(decoded);
    if (!old.success) return mergeEphemeralCredentials(store, emptyPersistedCache());
    const migrated = sanitizeLegacyDocument(old.data);
    persist(store, { ...emptyCache(), ...migrated });
    if (legacy !== null) store?.removeItem?.(LEGACY_WEBHOOK_CREDENTIALS_KEY);
    return mergeEphemeralCredentials(store, migrated);
  } catch {
    return mergeEphemeralCredentials(store, emptyPersistedCache());
  }
}

export function loadWebhookCredentials(store: Store): WebhookCredentialInventory {
  const inventory: WebhookCredentialInventory = {};
  for (const [webhookId, entry] of Object.entries(loadWebhookCredentialCache(store).credentials)) {
    inventory[webhookId] = entry.credential;
  }
  return inventory;
}

/** Save only if this response is not older than an already observed SSE or
 * rotation response. Equal versions are allowed because SSE can arrive just
 * before the matching one-time HTTP response. */
export function saveWebhookCredential(
  store: Store,
  webhookId: string,
  credential: WebhookCredential,
  credentialVersion: number,
): boolean {
  const cache = loadWebhookCredentialCache(store);
  if (cache.deleted[webhookId]) return false;
  if (credentialVersion < (cache.versions[webhookId] ?? 0)) return false;
  credentialBucket(store)[webhookId] = { credential, credentialVersion };
  cache.credentials[webhookId] = { credential, credentialVersion };
  cache.versions[webhookId] = credentialVersion;
  persist(store, cache);
  return true;
}

/** Apply a public webhook SSE revision. A matching revision belongs to the
 * credential response we already hold; only a strictly newer secret version
 * invalidates it. */
export function invalidateWebhookCredentialVersion(
  store: Store,
  webhookId: string,
  credentialVersion: number,
): boolean {
  const cache = loadWebhookCredentialCache(store);
  const entry = cache.credentials[webhookId];
  const removed = Boolean(entry && credentialVersion > entry.credentialVersion);
  if (removed) delete credentialBucket(store)[webhookId];
  cache.versions[webhookId] = Math.max(cache.versions[webhookId] ?? 0, credentialVersion);
  persist(store, cache);
  return removed;
}

export function removeWebhookCredential(store: Store, webhookId: string): void {
  const cache = loadWebhookCredentialCache(store);
  delete credentialBucket(store)[webhookId];
  cache.deleted[webhookId] = true;
  persist(store, cache);
}

/** Reconcile the cache against the store projection already updated by SSE.
 * Missing IDs are deletion tombstones; higher credential versions are exact
 * rotations. Lower/out-of-order projections can never roll a watermark back. */
export function reconcileWebhookCredentialCache(
  store: Store,
  webhooks: readonly WebhookCredentialVersion[],
): WebhookCredentialCache {
  const cache = loadWebhookCredentialCache(store);
  const credentials = credentialBucket(store);
  const liveIds = new Set(webhooks.map((webhook) => webhook.id));
  for (const webhookId of Object.keys(credentials)) {
    if (liveIds.has(webhookId)) continue;
    delete credentials[webhookId];
    cache.deleted[webhookId] = true;
  }
  for (const webhook of webhooks) {
    const entry = credentials[webhook.id];
    if (entry && webhook.credentialVersion > entry.credentialVersion) {
      delete credentials[webhook.id];
    }
    cache.versions[webhook.id] = Math.max(
      cache.versions[webhook.id] ?? 0,
      webhook.credentialVersion,
    );
  }
  persist(store, cache);
  return loadWebhookCredentialCache(store);
}

export function webhookCredentialStore(): Store {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
