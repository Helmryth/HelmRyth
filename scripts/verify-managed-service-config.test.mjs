import { describe, expect, it } from "vitest";

import { verifyManagedServiceConfig } from "./verify-managed-service-config.mjs";

const valid = JSON.stringify({
  schemaVersion: 1,
  registryOrigin: "https://registry.helmryth.example",
  conduitOrigin: "https://conduit.helmryth.example",
});

describe("managed service release config verification", () => {
  it("accepts the protected managed-services contract", () => {
    expect(
      verifyManagedServiceConfig(valid, {
        registryOrigin: "https://registry.helmryth.example",
        conduitOrigin: "https://conduit.helmryth.example",
      }),
    ).toEqual({
      schemaVersion: 1,
      registryOrigin: "https://registry.helmryth.example",
      conduitOrigin: "https://conduit.helmryth.example",
    });
  });

  it("rejects drifted or malformed managed-services config", () => {
    expect(() =>
      verifyManagedServiceConfig("[]", {
        registryOrigin: "https://registry.helmryth.example",
        conduitOrigin: "https://conduit.helmryth.example",
      }),
    ).toThrow(/one object/);
    expect(() =>
      verifyManagedServiceConfig(
        JSON.stringify({
          schemaVersion: 1,
          registryOrigin: "https://other.example",
          conduitOrigin: "https://conduit.helmryth.example",
        }),
        {
          registryOrigin: "https://registry.helmryth.example",
          conduitOrigin: "https://conduit.helmryth.example",
        },
      ),
    ).toThrow(/registryOrigin/);
    expect(() =>
      verifyManagedServiceConfig(
        JSON.stringify({
          schemaVersion: 1,
          registryOrigin: "https://registry.helmryth.example",
          conduitUrl: "https://conduit.helmryth.example",
          conduitOrigin: "https://conduit.helmryth.example",
        }),
        {
          registryOrigin: "https://registry.helmryth.example",
          conduitOrigin: "https://conduit.helmryth.example",
        },
      ),
    ).toThrow(/exactly schemaVersion, registryOrigin, and conduitOrigin/);
  });
});
