import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "./local-computer";

function providerInstance(capabilities: InstanceInfo["capabilities"]): InstanceInfo {
  return {
    instanceId: "claude",
    driverKind: "test",
    displayName: "Test engine",
    snapshot: { state: "available" },
    models: { default: "test", options: [{ id: "test", label: "Test" }] },
    capabilities,
  };
}

function desktopCapabilities(
  platform: DesktopCapabilities["host"]["platform"],
  localComputer: Partial<DesktopCapabilities["localComputer"]> = {},
): DesktopCapabilities {
  return {
    host: {
      platform,
      label: "Test desktop",
      session: "unknown",
      packaged: false,
    },
    windowChrome: "native",
    screenPreview: { available: false, interaction: "none" },
    dictation: { available: false, engine: "none", onDevice: false },
    localComputer: {
      available: false,
      support: "supported",
      enabled: false,
      status: "unavailable",
      ...localComputer,
    },
  };
}

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [providerInstance({ localComputerMcp: true })];
    expect(instanceSupportsLocalComputer(instances, bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }],
        bot,
      ),
    ).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = desktopCapabilities("darwin");
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: desktopCapabilities("linux"),
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise Workbench access stays off");
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = desktopCapabilities("linux", {
      reasonCode: "linux-wayland-seat-safety-blocked",
    });

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "The Host Workbench is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use the host desktop.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: "cloud",
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });
});
