import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveUpdateChannel } from "./update-channel.mjs";

test("development never contacts a release channel", () => {
  let checked = false;
  assert.deepEqual(
    resolveUpdateChannel({
      isPackaged: false,
      resourcesPath: "/app/resources",
      fileExists: () => {
        checked = true;
        return true;
      },
    }),
    { available: false, reason: "development" },
  );
  assert.equal(checked, false);
});

test("a package without an owned update configuration fails closed", () => {
  const configurationPath = path.join("/app/resources", "app-update.yml");
  assert.deepEqual(
    resolveUpdateChannel({
      isPackaged: true,
      resourcesPath: "/app/resources",
      fileExists: (candidate) => candidate === "/not-ours/app-update.yml",
    }),
    { available: false, reason: "not-provisioned", configurationPath },
  );
});

test("a packaged build accepts its explicit update configuration", () => {
  const configurationPath = path.join("/app/resources", "app-update.yml");
  assert.deepEqual(
    resolveUpdateChannel({
      isPackaged: true,
      resourcesPath: "/app/resources",
      fileExists: (candidate) => candidate === configurationPath,
    }),
    { available: true, configurationPath },
  );
});
