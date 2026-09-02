import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectProductionConfigErrors } from "./deploy-preflight.mjs";

function validConfig() {
  return {
    name: "helmryth-registry",
    workers_dev: false,
    routes: [{ pattern: "registry.helmryth.com", custom_domain: true }],
    vars: {
      HELMRYTH_REGISTRY_ORIGIN: "https://registry.helmryth.com",
      HELMRYTH_EMAIL_FROM: "noreply@updates.helmryth.com",
      HELMRYTH_NODE_ORIGINS: "https://desktop.helmryth.com, https://ops.helmryth.com",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_ZONE_ID: "abcdef0123456789abcdef0123456789",
      HELMRYTH_REACH_HOST_SUFFIX: "reach.helmryth.com",
      HELMRYTH_REACH_ORIGIN: "http://127.0.0.1:8812",
    },
    secrets: { required: ["HELMRYTH_REGISTRY_AUTH_SECRET", "CLOUDFLARE_API_TOKEN"] },
    d1_databases: [{ binding: "REGISTRY_DB", database_id: "11111111-2222-4333-8444-555555555555" }],
    send_email: [{ name: "REGISTRY_EMAIL", allowed_sender_addresses: ["noreply@updates.helmryth.com"] }],
  };
}

test("accepts a route-locked production configuration", () => {
  assert.deepEqual(collectProductionConfigErrors(validConfig()), []);
});

const unsafeCases = [
  ["Workers.dev exposure", (config) => { config.workers_dev = true; }, /workers_dev must be false/],
  ["multiple routes", (config) => { config.routes.push({ pattern: "alt.helmryth.com", custom_domain: true }); }, /exactly one custom hostname route/],
  ["wildcard route", (config) => { config.routes[0].pattern = "*.helmryth.com"; }, /must not use wildcards/],
  ["non-custom-domain route", (config) => { config.routes[0].custom_domain = false; }, /custom_domain entry/],
  ["placeholder route", (config) => { config.routes[0].pattern = "registry.example.com"; config.vars.HELMRYTH_REGISTRY_ORIGIN = "https://registry.example.com"; }, /owned hostname/],
  ["route mismatch", (config) => { config.routes[0].pattern = "auth.helmryth.com"; }, /must match HELMRYTH_REGISTRY_ORIGIN exactly/],
  ["origin path drift", (config) => { config.vars.HELMRYTH_REGISTRY_ORIGIN = "https://registry.helmryth.com/v1"; }, /without a path/],
  ["wildcard node origin", (config) => { config.vars.HELMRYTH_NODE_ORIGINS = "https://*.helmryth.com"; }, /must not use wildcard hosts/],
  ["placeholder node origin", (config) => { config.vars.HELMRYTH_NODE_ORIGINS = "https://desktop.helmryth.test"; }, /owned hostname/],
  ["missing node origins", (config) => { config.vars.HELMRYTH_NODE_ORIGINS = ""; }, /must include at least one exact HTTPS origin/],
  ["placeholder account id", (config) => { config.vars.CLOUDFLARE_ACCOUNT_ID = "00000000000000000000000000000000"; }, /must not be all zeroes/],
  ["placeholder zone id", (config) => { config.vars.CLOUDFLARE_ZONE_ID = "00000000000000000000000000000000"; }, /must not be all zeroes/],
  ["placeholder reach suffix", (config) => { config.vars.HELMRYTH_REACH_HOST_SUFFIX = "reach.helmryth.test"; }, /owned DNS suffix/],
  ["non-loopback reach origin", (config) => { config.vars.HELMRYTH_REACH_ORIGIN = "https://reach.helmryth.com"; }, /must use HTTP/],
  ["placeholder sender", (config) => { config.vars.HELMRYTH_EMAIL_FROM = "noreply@example.com"; config.send_email[0].allowed_sender_addresses = ["noreply@example.com"]; }, /verified sender domain you control/],
  ["sender mismatch", (config) => { config.send_email[0].allowed_sender_addresses = ["ops@updates.helmryth.com"]; }, /exactly match HELMRYTH_EMAIL_FROM/],
  ["multiple sender addresses", (config) => { config.send_email[0].allowed_sender_addresses = ["noreply@updates.helmryth.com", "ops@updates.helmryth.com"]; }, /exactly one verified sender address/],
  ["missing sender binding", (config) => { config.send_email = []; }, /REGISTRY_EMAIL send_email binding must be configured/],
  ["missing auth secret declaration", (config) => { config.secrets.required = ["CLOUDFLARE_API_TOKEN"]; }, /HELMRYTH_REGISTRY_AUTH_SECRET/],
  ["missing API token declaration", (config) => { config.secrets.required = ["HELMRYTH_REGISTRY_AUTH_SECRET"]; }, /CLOUDFLARE_API_TOKEN/],
  ["placeholder D1", (config) => { config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000"; }, /D1 database ID must not be all zeroes/],
];

for (const [name, mutate, expected] of unsafeCases) {
  test(`rejects ${name}`, () => {
    const config = validConfig();
    mutate(config);
    assert.match(collectProductionConfigErrors(config).join("\n"), expected);
  });
}

test("the command exits nonzero for an unsafe deployment file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hry-registry-preflight-"));
  const configPath = join(dir, "wrangler.jsonc");
  try {
    const config = validConfig();
    config.workers_dev = true;
    writeFileSync(configPath, JSON.stringify(config));
    const script = fileURLToPath(new URL("./deploy-preflight.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--config", configPath], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workers_dev must be false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
