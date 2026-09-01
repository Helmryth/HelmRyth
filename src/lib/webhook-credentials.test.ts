import { describe, expect, it } from "vitest";

import {
  invalidateWebhookCredentialVersion,
  loadWebhookCredentialCache,
  loadWebhookCredentials,
  removeWebhookCredential,
  reconcileWebhookCredentialCache,
  saveWebhookCredential,
  WEBHOOK_CREDENTIALS_KEY,
} from "./webhook-credentials.js";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const credential = {
  endpointUrl: "http://127.0.0.1:8800/hooks/wh_demo",
  secret: "whsec_demo",
  idempotencyKey: "hry_evt_demo",
};

describe("webhook credential storage", () => {
  it("keeps a one-time private URL available after the panel remounts", () => {
    const store = memoryStore();
    saveWebhookCredential(store, "hook-1", credential, 1);
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).toBe(JSON.stringify({
      versions: { "hook-1": 1 },
      deleted: {},
    }));
  });

  it("scrubs legacy entries and removes deleted webhooks", () => {
    const store = memoryStore();
    store.setItem("omb-webhook-credentials", JSON.stringify({ broken: { url: 3 }, "hook-1": credential }));
    expect(loadWebhookCredentials(store)).toEqual({});
    expect(store.getItem("omb-webhook-credentials")).toBeNull();
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).toBe(JSON.stringify({
      versions: { "hook-1": 1 },
      deleted: {},
    }));
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("whsec_demo");
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("/hooks/wh_demo/whsec_demo");
    removeWebhookCredential(store, "hook-1");
    expect(loadWebhookCredentials(store)).toEqual({});
  });

  it("invalidates an older secret on external rotation but preserves the matching response ordering", () => {
    const store = memoryStore();
    expect(saveWebhookCredential(store, "hook-1", credential, 1)).toBe(true);
    expect(invalidateWebhookCredentialVersion(store, "hook-1", 1)).toBe(false);
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": credential });

    expect(invalidateWebhookCredentialVersion(store, "hook-1", 2)).toBe(true);
    expect(loadWebhookCredentials(store)).toEqual({});
    expect(saveWebhookCredential(store, "hook-1", credential, 1)).toBe(false);

    const replacement = { ...credential, secret: "whsec_replacement", idempotencyKey: "hry_evt_replacement" };
    expect(saveWebhookCredential(store, "hook-1", replacement, 2)).toBe(true);
    expect(loadWebhookCredentials(store)).toEqual({ "hook-1": replacement });
  });

  it("keeps a deletion tombstone so a late rotate response cannot resurrect plaintext", () => {
    const store = memoryStore();
    saveWebhookCredential(store, "hook-1", credential, 3);
    removeWebhookCredential(store, "hook-1");
    expect(saveWebhookCredential(store, "hook-1", credential, 3)).toBe(false);
    expect(loadWebhookCredentialCache(store).deleted["hook-1"]).toBe(true);
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("whsec_demo");
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("/hooks/wh_demo/whsec_demo");
  });

  it("reconciles rotated and deleted SSE state in any remount ordering", () => {
    const store = memoryStore();
    saveWebhookCredential(store, "hook-1", credential, 1);
    saveWebhookCredential(store, "hook-2", { ...credential, secret: "whsec_two" }, 4);

    const cache = reconcileWebhookCredentialCache(store, [
      { id: "hook-1", credentialVersion: 2 },
    ]);
    expect(cache.credentials).toEqual({});
    expect(cache.versions).toMatchObject({ "hook-1": 2, "hook-2": 4 });
    expect(cache.deleted["hook-2"]).toBe(true);
  });

  it("scrubs old canonical cache documents that serialized secrets", () => {
    const store = memoryStore();
    store.setItem(WEBHOOK_CREDENTIALS_KEY, JSON.stringify({
      credentials: {
        "hook-1": {
          credential,
          credentialVersion: 7,
        },
      },
      versions: { "hook-1": 7 },
      deleted: {},
    }));

    expect(loadWebhookCredentials(store)).toEqual({});
    expect(loadWebhookCredentialCache(store).versions["hook-1"]).toBe(7);
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).toBe(JSON.stringify({
      versions: { "hook-1": 7 },
      deleted: {},
    }));
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("whsec_demo");
    expect(store.getItem(WEBHOOK_CREDENTIALS_KEY)).not.toContain("/hooks/wh_demo/whsec_demo");
  });
});
