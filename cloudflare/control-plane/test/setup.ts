import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.REGISTRY_DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  await env.REGISTRY_DB.batch([
    env.REGISTRY_DB.prepare("DELETE FROM otp_recipient_rate_limits"),
    env.REGISTRY_DB.prepare("DELETE FROM registry_action_rate_limits"),
    env.REGISTRY_DB.prepare("DELETE FROM node_action_rate_limits"),
    env.REGISTRY_DB.prepare("DELETE FROM node_reaches"),
    env.REGISTRY_DB.prepare("DELETE FROM node_credentials"),
    env.REGISTRY_DB.prepare("DELETE FROM nodes"),
    env.REGISTRY_DB.prepare('DELETE FROM "session"'),
    env.REGISTRY_DB.prepare('DELETE FROM "account"'),
    env.REGISTRY_DB.prepare('DELETE FROM "verification"'),
    env.REGISTRY_DB.prepare('DELETE FROM "rateLimit"'),
    env.REGISTRY_DB.prepare('DELETE FROM "user"'),
  ]);
});
