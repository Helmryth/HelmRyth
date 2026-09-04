import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  MANAGED_SERVICE_CONFIG_NAME,
  createTemporaryReleaseBuilderConfig,
  parseReleaseRepository,
  parsePublisherNames,
  releaseManagedServiceConfig,
  releaseBuilderConfig,
} from "./release-builder-config.mjs";

const baseConfigText = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

describe("release-only Electron Builder configuration", () => {
  it("accepts an explicit GitHub owner/repo and preserves it exactly", () => {
    expect(parseReleaseRepository("helmryth-labs/helmryth-releases")).toEqual({
      owner: "helmryth-labs",
      repo: "helmryth-releases",
      slug: "helmryth-labs/helmryth-releases",
    });
  });

  it.each([
    undefined,
    "",
    "owner",
    "owner/repo/extra",
    " owner/repo",
    "owner/repo ",
    "https://github.com/owner/repo",
    "owner_name/repo",
    "-owner/repo",
    "owner-/repo",
    "owner/..",
    "owner/repo.git",
  ])("rejects missing, ambiguous, URL-shaped, or invalid input: %s", (value) => {
    expect(() => parseReleaseRepository(value)).toThrow(/HELMRYTH_RELEASE_REPO|invalid GitHub/);
  });

  it("proves the checked-in local config has no publish destination", () => {
    const local = YAML.parse(baseConfigText);
    expect(Object.hasOwn(local, "publish")).toBe(false);
  });

  it("adds exactly one explicit GitHub target without mutating the local config", () => {
    const release = releaseBuilderConfig(baseConfigText, "helmryth-labs/releases");
    expect(release.publish).toEqual([
      { provider: "github", owner: "helmryth-labs", repo: "releases" },
    ]);
    expect(Object.hasOwn(YAML.parse(baseConfigText), "publish")).toBe(false);
  });

  it("builds the signed packaged managed-services contract for official releases", () => {
    expect(
      releaseManagedServiceConfig({
        registryOrigin: "https://registry.helmryth.example",
        conduitOrigin: "https://conduit.helmryth.example",
      }),
    ).toEqual({
      schemaVersion: 1,
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });
    expect(() =>
      releaseManagedServiceConfig({
        registryOrigin: "http://127.0.0.1:8787",
        conduitOrigin: "https://conduit.helmryth.example",
      }),
    ).toThrow(/HELMRYTH_RELEASE_REGISTRY_ORIGIN/);
  });

  it("parses exact Windows publisher identities from a string or JSON array", () => {
    expect(parsePublisherNames("Helmryth, Inc.")).toEqual(["Helmryth, Inc."]);
    expect(parsePublisherNames('["Helmryth, Inc.","Helmryth LLC"]')).toEqual([
      "Helmryth, Inc.",
      "Helmryth LLC",
    ]);
    expect(() => parsePublisherNames("[]")).toThrow(/publisher identity/);
  });

  it("refuses a base config that gains any implicit publish destination", () => {
    expect(() => releaseBuilderConfig(`${baseConfigText}\npublish: null\n`, "owner/repo")).toThrow(
      /publish-free/,
    );
  });

  it("writes a private temporary overlay and removes it deterministically", () => {
    const generated = createTemporaryReleaseBuilderConfig({
      releaseRepository: "helmryth-labs/releases",
      releaseRegistryOrigin: "https://registry.helmryth.example",
      releaseConduitOrigin: "https://conduit.helmryth.example",
    });
    const directory = path.dirname(generated.configPath);
    try {
      expect(existsSync(generated.configPath)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(generated.configPath).mode & 0o777).toBe(0o600);
      }
      expect(YAML.parse(readFileSync(generated.configPath, "utf8")).publish).toEqual([
        { provider: "github", owner: "helmryth-labs", repo: "releases" },
      ]);
      expect(generated.serviceConfig).toEqual({
        schemaVersion: 1,
        registryOrigin: "https://registry.helmryth.example",
        conduitOrigin: "https://conduit.helmryth.example",
      });
      expect(path.basename(generated.serviceConfigPath)).toBe(MANAGED_SERVICE_CONFIG_NAME);
    } finally {
      generated.cleanup();
    }
    expect(existsSync(directory)).toBe(false);
  });

  it("generates a Windows config electron-builder's own schema accepts", () => {
    // The bug this pins cost nothing at generation time and everything at
    // package time: `publisherName` sat at the top of `win`, where
    // WindowsConfiguration declares `additionalProperties: false`, so
    // validateConfiguration threw before any packaging work began. A unit test
    // asserting our own shape could not see that — the authority is
    // electron-builder's scheme.json, so this reads it.
    const fromHere = createRequire(import.meta.url);
    const fromBuilder = createRequire(fromHere.resolve("electron-builder/package.json"));
    const scheme = fromBuilder("app-builder-lib/scheme.json");

    const release = releaseBuilderConfig(baseConfigText, "helmryth-labs/releases", {
      target: "win",
      windowsSigning: {
        certificateFile: "C:/tmp/helmryth-release.pfx",
        certificatePassword: "hunter2-not-a-real-secret",
        publisherName: ["Helmryth, Inc."],
        timeStampServer: "http://timestamp.example.test",
        signingHashAlgorithms: ["sha256"],
      },
    });

    const unknown = (definition, object) =>
      Object.keys(object).filter((key) => !(key in scheme.definitions[definition].properties));

    expect(scheme.definitions.WindowsConfiguration.additionalProperties).toBe(false);
    expect(unknown("WindowsConfiguration", release.win)).toEqual([]);
    expect(unknown("WindowsSigntoolConfiguration", release.win.signtoolOptions)).toEqual([]);
  });

  it("injects Windows signing inputs only for official Windows releases", () => {
    const release = releaseBuilderConfig(baseConfigText, "helmryth-labs/releases", {
      target: "win",
      managedServiceConfigPath: "/tmp/helmryth-service-config.json",
      windowsSigning: {
        certificateFile: "C:/tmp/helmryth-release.pfx",
        certificatePassword: "hunter2-not-a-real-secret",
        publisherName: ["Helmryth, Inc."],
        timeStampServer: "http://timestamp.example.test",
        signingHashAlgorithms: ["sha256"],
      },
    });
    expect(release.extraResources).toContainEqual({
      from: "/tmp/helmryth-service-config.json",
      to: MANAGED_SERVICE_CONFIG_NAME,
    });
    // Under signtoolOptions, not at the top of `win`: WindowsConfiguration is
    // declared additionalProperties:false in electron-builder's schema, so the
    // key is rejected there rather than ignored.
    expect(release.win.publisherName).toBeUndefined();
    expect(release.win.signtoolOptions.publisherName).toEqual(["Helmryth, Inc."]);
    expect(release.win.signtoolOptions).toMatchObject({
      certificateFile: "C:/tmp/helmryth-release.pfx",
      certificatePassword: "hunter2-not-a-real-secret",
      timeStampServer: "http://timestamp.example.test",
      signingHashAlgorithms: ["sha256"],
    });
  });

  it("fails closed when a Windows release lacks signing inputs", () => {
    expect(() =>
      releaseBuilderConfig(baseConfigText, "helmryth-labs/releases", {
        target: "win",
        managedServiceConfigPath: "/tmp/helmryth-service-config.json",
      }),
    ).toThrow(/Authenticode signing/);
  });
});
