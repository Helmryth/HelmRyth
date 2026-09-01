// Split engines by what their catalog can actually select, rather than by how
// the engine is paid for. `access: "custom"` means BYOK/custom access; it does
// not mean the endpoint is local. A BYOK OpenAI-compatible or MiniMax API with
// normal enumerated models therefore stays on Cloud. Local is reserved for
// engines whose catalog is empty or contains only injected (`custom`) models.
// A missing `access` remains Cloud so older payloads stay in the top group.
interface EngineRailInstance {
  instanceId: string;
  access?: "subscription" | "custom";
  models?: { options: readonly { id: string; custom?: boolean }[] };
}

export function isCustomOnly<T extends EngineRailInstance>(instance: T | undefined): boolean {
  return instance?.access === "custom"
    && !instance.models?.options.some((option) => option.custom !== true);
}

export interface EngineRailSplit<T> {
  subscription: T[];
  custom: T[];
}

export function splitEngineRail<T extends EngineRailInstance>(
  instances: readonly T[],
): EngineRailSplit<T> {
  const subscription: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    if (isCustomOnly(instance)) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom };
}
