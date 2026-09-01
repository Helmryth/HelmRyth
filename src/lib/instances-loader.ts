import { z } from "zod";

import type { InstanceInfo } from "@/state/store";

export type InstancesFetch = (input: string) => Promise<Pick<Response, "ok" | "json">>;

const instanceInfoSchema = z.object({
  instanceId: z.string(),
  driverKind: z.string(),
  displayName: z.string(),
  snapshot: z.object({
    state: z.enum(["available", "unavailable"]),
    reason: z.string().optional(),
    authenticated: z.boolean().optional(),
    version: z.string().nullable().optional(),
    billing: z.enum(["metered", "subscription"]).optional(),
  }).passthrough(),
  models: z.object({
    default: z.string(),
    options: z.array(z.object({
      id: z.string(),
      label: z.string(),
      custom: z.boolean().optional(),
      loaded: z.boolean().optional(),
    }).passthrough()),
  }).passthrough(),
  capabilities: z.object({
    computerMcp: z.boolean().optional(),
    agentsMcp: z.boolean().optional(),
    composioMcp: z.boolean().optional(),
    browserMcp: z.boolean().optional(),
    images: z.boolean().optional(),
    effortLevels: z.array(z.enum(["none", "low", "medium", "high", "xhigh", "max"])).optional(),
    queueing: z.boolean().optional(),
    localComputerMcp: z.boolean().optional(),
    approvalReview: z.boolean().optional(),
  }).passthrough().optional(),
  access: z.enum(["subscription", "custom"]).optional(),
  install: z.object({
    command: z.object({
      darwin: z.string().optional(),
      win32: z.string().optional(),
      linux: z.string().optional(),
    }).passthrough().optional(),
    docsUrl: z.string().optional(),
    signInCommand: z.string().optional(),
    needsNode: z.boolean().optional(),
  }).passthrough().optional(),
  cli: z.string().optional(),
  cliDefault: z.string().optional(),
  cliCandidates: z.array(z.string()).optional(),
}).passthrough();

const instancesPayloadSchema = z.object({ instances: z.array(instanceInfoSchema) });

type InstancesLoaderOptions = {
  cacheMs?: number;
  now?: () => number;
  path?: string;
};

export type InstancesLoadOptions = {
  force?: boolean;
};

export interface InstancesLoader {
  load(options?: InstancesLoadOptions): Promise<InstanceInfo[]>;
  invalidate(): void;
}

const DEFAULT_CACHE_MS = 3_000;

export async function loadValidatedInstances(
  fetchInstances: InstancesFetch,
  path = "/api/instances",
): Promise<InstanceInfo[]> {
  try {
    const response = await fetchInstances(path);
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    const parsed = instancesPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data.instances : [];
  } catch {
    return [];
  }
}

export function createInstancesLoader(
  fetchInstances: InstancesFetch,
  {
    cacheMs = DEFAULT_CACHE_MS,
    now = Date.now,
    path = "/api/instances",
  }: InstancesLoaderOptions = {},
): InstancesLoader {
  let pending: Promise<InstanceInfo[]> | null = null;
  let cache: { instances: InstanceInfo[]; at: number } | null = null;

  return {
    load({ force = false }: InstancesLoadOptions = {}) {
      if (pending) return pending;
      if (!force && cache && now() - cache.at <= cacheMs) return Promise.resolve(cache.instances);

      const request = loadValidatedInstances(fetchInstances, path).then((instances) => {
        cache = { instances, at: now() };
        return instances;
      }).finally(() => {
        if (pending === request) pending = null;
      });
      pending = request;
      return request;
    },
    invalidate() {
      cache = null;
    },
  };
}

let sharedInstancesLoader: InstancesLoader | null = null;

function browserFetchInstances(input: string): Promise<Pick<Response, "ok" | "json">> {
  return fetch(input);
}

function getSharedInstancesLoader(): InstancesLoader {
  sharedInstancesLoader ??= createInstancesLoader(browserFetchInstances);
  return sharedInstancesLoader;
}

export function loadSharedInstances(options?: InstancesLoadOptions): Promise<InstanceInfo[]> {
  return getSharedInstancesLoader().load(options);
}

export function invalidateSharedInstances(): void {
  getSharedInstancesLoader().invalidate();
}

export function resetSharedInstancesLoaderForTests(): void {
  sharedInstancesLoader = null;
}
