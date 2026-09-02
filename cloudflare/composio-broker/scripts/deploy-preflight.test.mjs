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
    name: "helmryth-conduit",
    workers_dev: false,
    routes: [{ pattern: "conduit.helmryth.com", custom_domain: true }],
    vars: {
      HELMRYTH_CONDUIT_ENROLLMENT_MODE: "closed",
      HELMRYTH_CONDUIT_ORIGIN: "https://conduit.helmryth.com",
      COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
      COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3",
    },
    secrets: { required: ["COMPOSIO_API_KEY"] },
    d1_databases: [{ binding: "CONDUIT_DB", database_id: "11111111-2222-4333-8444-555555555555" }],
    ratelimits: [
      { name: "NODE_ENROLLMENT_LIMITER", namespace_id: "8461201" },
      { name: "CONDUIT_SESSION_LIMITER", namespace_id: "8461202" },
    ],
  };
}

test("accepts a closed, route-owned production configuration", () => {
  assert.deepEqual(collectProductionConfigErrors(validConfig()), []);
});

const unsafeCases = [
  ["Workers.dev exposure", (config) => { config.workers_dev = true; }, /workers_dev must be false/],
  ["open enrollment", (config) => { config.vars.HELMRYTH_CONDUIT_ENROLLMENT_MODE = "open"; }, /enrollment mode must be closed/],
  ["placeholder D1", (config) => { config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000"; }, /D1 database ID/],
  ["placeholder enrollment limiter", (config) => { config.ratelimits[0].namespace_id = "0000000"; }, /NODE_ENROLLMENT_LIMITER/],
  ["placeholder Session limiter", (config) => { config.ratelimits[1].namespace_id = "0"; }, /CONDUIT_SESSION_LIMITER/],
  ["missing route", (config) => { config.routes = []; }, /explicit owned route/],
  ["missing origin", (config) => { delete config.vars.HELMRYTH_CONDUIT_ORIGIN; }, /HTTPS owned origin/],
  ["HTTP origin", (config) => { config.vars.HELMRYTH_CONDUIT_ORIGIN = "http://conduit.helmryth.com"; }, /must use HTTPS/],
  ["Workers.dev origin", (config) => {
    config.vars.HELMRYTH_CONDUIT_ORIGIN = "https://helmryth-conduit.workers.dev";
    config.routes[0].pattern = "helmryth-conduit.workers.dev";
  }, /owned hostname/],
  ["placeholder origin", (config) => {
    config.vars.HELMRYTH_CONDUIT_ORIGIN = "https://conduit.invalid";
    config.routes[0].pattern = "conduit.invalid";
  }, /owned hostname/],
  ["route mismatch", (config) => { config.routes[0].pattern = "other.helmryth.com"; }, /must match HELMRYTH_CONDUIT_ORIGIN/],
  ["missing Composio secret declaration", (config) => { config.secrets.required = []; }, /COMPOSIO_API_KEY/],
];

for (const [name, mutate, expected] of unsafeCases) {
  test(`rejects ${name}`, () => {
    const config = validConfig();
    mutate(config);
    assert.match(collectProductionConfigErrors(config).join("\n"), expected);
  });
}

test("the command exits nonzero for an unsafe deployment file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hry-conduit-preflight-"));
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
