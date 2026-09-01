import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { releaseManagedServiceConfig } from "../scripts/release-builder-config.mjs";

import {
  MANAGED_SERVICE_CONFIG_FILENAME,
  loadManagedServiceConfig,
  managedServiceChildEnvironment,
  managedServiceConfigStatus,
  parseManagedServiceConfig,
} from "./managed-service-config.mjs";

const productionDocument = JSON.stringify({
  schemaVersion: 1,
  registryOrigin: "https://registry.helmryth.example",
  conduitOrigin: "https://conduit.helmryth.example",
});

describe("managed service configuration", () => {
  it("decodes the exact resource emitted by the protected release lane", () => {
    const generated = releaseManagedServiceConfig({
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });
    expect(parseManagedServiceConfig(JSON.stringify(generated))).toEqual({
      source: "packaged",
      state: "ready",
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });
  });

  it("accepts only the versioned, exact HTTPS origin contract", () => {
    expect(parseManagedServiceConfig(productionDocument)).toEqual({
      source: "packaged",
      state: "ready",
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });

    for (const document of [
      "{}",
      JSON.stringify({ schemaVersion: 2, registryOrigin: "https://registry.test", conduitOrigin: "https://conduit.test" }),
      JSON.stringify({ schemaVersion: 1, registryOrigin: "http://registry.test", conduitOrigin: "https://conduit.test" }),
      JSON.stringify({ schemaVersion: 1, registryOrigin: "https://registry.test/path", conduitOrigin: "https://conduit.test" }),
      JSON.stringify({ schemaVersion: 1, registryOrigin: "https://user:secret@registry.test", conduitOrigin: "https://conduit.test" }),
      JSON.stringify({ schemaVersion: 1, registryOrigin: "https://registry.test", conduitOrigin: "https://conduit.test?redirect=bad" }),
      JSON.stringify({ schemaVersion: 1, registryOrigin: "https://registry.test", conduitOrigin: "https://conduit.test", extra: true }),
    ]) {
      expect(() => parseManagedServiceConfig(document)).toThrow(/managed service configuration/i);
    }
  });

  it("loads the signed packaged resource and ignores shell overrides", () => {
    const readFile = vi.fn(() => productionDocument);
    const resourcesPath = path.join("", "opt", "Helmryth", "resources");
    const config = loadManagedServiceConfig({
      isPackaged: true,
      resourcesPath,
      environment: {
        HELMRYTH_REGISTRY_ORIGIN: "https://attacker.invalid",
        HELMRYTH_CONDUIT_URL: "https://attacker.invalid",
      },
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith(
      path.join(resourcesPath, MANAGED_SERVICE_CONFIG_FILENAME),
      "utf8",
    );
    expect(config).toMatchObject({
      source: "packaged",
      state: "ready",
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });
  });

  it("fails closed when the packaged resource is absent or invalid", () => {
    const absent = loadManagedServiceConfig({
      isPackaged: true,
      resourcesPath: "/missing",
      environment: {
        HELMRYTH_REGISTRY_ORIGIN: "https://registry.from-shell.invalid",
        HELMRYTH_CONDUIT_URL: "https://conduit.from-shell.invalid",
      },
      readFile: () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    });
    expect(absent).toEqual({
      source: "packaged",
      state: "missing",
      registryOrigin: "",
      conduitOrigin: "",
    });

    const invalid = loadManagedServiceConfig({
      isPackaged: true,
      resourcesPath: "/invalid",
      environment: {},
      readFile: () => JSON.stringify({
        schemaVersion: 1,
        registryOrigin: "http://registry.invalid",
        conduitOrigin: "https://conduit.test",
      }),
    });
    expect(invalid).toEqual({
      source: "packaged",
      state: "invalid",
      registryOrigin: "",
      conduitOrigin: "",
    });
  });

  it("allows explicit environment origins only outside packaged builds", () => {
    expect(loadManagedServiceConfig({
      isPackaged: false,
      resourcesPath: "/unused",
      environment: {
        HELMRYTH_REGISTRY_ORIGIN: "http://127.0.0.1:8787",
        HELMRYTH_CONDUIT_URL: "http://localhost:8788",
      },
      readFile: vi.fn(),
    })).toEqual({
      source: "development",
      state: "ready",
      registryOrigin: "http://127.0.0.1:8787",
      conduitOrigin: "http://localhost:8788",
    });

    expect(loadManagedServiceConfig({
      isPackaged: false,
      resourcesPath: "/unused",
      environment: { HELMRYTH_REGISTRY_ORIGIN: "http://remote.invalid" },
      readFile: vi.fn(),
    })).toEqual({
      source: "development",
      state: "invalid",
      registryOrigin: "",
      conduitOrigin: "",
    });
  });

  it("publishes only non-secret readiness and owned origins", () => {
    expect(managedServiceConfigStatus({
      source: "packaged",
      state: "ready",
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
      token: "must-not-pass",
    })).toEqual({
      source: "packaged",
      state: "ready",
      registry: { configured: true, origin: "https://registry.helmryth.example" },
      conduit: { configured: true, origin: "https://conduit.helmryth.example" },
    });
  });

  it("replaces inherited managed-service variables before spawning the server", () => {
    expect(managedServiceChildEnvironment({
      source: "packaged",
      state: "ready",
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    }, {
      PATH: "/usr/bin",
      HELMRYTH_REGISTRY_ORIGIN: "https://attacker.invalid",
      HELMRYTH_CONDUIT_URL: "https://attacker.invalid",
      HELMRYTH_MANAGED_CONFIG_SOURCE: "development",
      HELMRYTH_MANAGED_CONFIG_STATE: "ready",
      HELMRYTH_MANAGED_REGISTRY_ORIGIN: "https://attacker.invalid",
      HELMRYTH_MANAGED_CONDUIT_ORIGIN: "https://attacker.invalid",
    })).toEqual({
      PATH: "/usr/bin",
      HELMRYTH_MANAGED_CONFIG_SOURCE: "packaged",
      HELMRYTH_MANAGED_CONFIG_STATE: "ready",
      HELMRYTH_MANAGED_REGISTRY_ORIGIN: "https://registry.helmryth.example",
      HELMRYTH_MANAGED_CONDUIT_ORIGIN: "https://conduit.helmryth.example",
    });
  });
});
