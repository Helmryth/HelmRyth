import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

/** Whether the execution-surface “Host” control should be clickable.
 *  macOS keeps the destination available before the Workbench Driver has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot present gates for Host Workbench actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "The Host Workbench is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use the host desktop.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "The Host Workbench on Wayland is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the Host Workbench beta and complete the driver checks first.";
    }
    return capabilities.localComputer.message?.replace(/\bCUA Driver\b/gi, "Workbench Driver")
      ?? "The Workbench Driver is not ready for host control.";
  }
  if (capabilities.host.label === "Browser") {
    return "The Host Workbench requires Helmryth Desktop.";
  }
  return "The Workbench Driver is not ready for host control.";
}

export function linuxAutoDescription(): string {
  return "Automatic selection uses a managed Remote Workbench when configured; otherwise Workbench access stays off.";
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}
