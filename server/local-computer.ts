import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { parseJson, type JsonValue } from "./schema.ts";

export const REQUIRED_LINUX_TOOLS = ["click", "get_window_state", "list_apps", "type_text"];
// Keep this exact field set synchronized with DRIVER_FILE_IDENTITY_KEYS in
// electron/cua-linux.cjs; Electron publishes it and the server revalidates it.
export const DRIVER_FILE_IDENTITY_KEYS = [
  "dev",
  "ino",
  "uid",
  "gid",
  "mode",
  "size",
  "mtimeNs",
  "ctimeNs",
] as const;

export type LocalComputerConnection = {
  command: string;
  args: string[];
  env: Record<string, string>;
  platform: "darwin" | "linux" | "win32";
  generation?: string;
  scope: "local-computer";
};

const decimalString = z.string().regex(/^\d+$/);
const driverFileIdentitySchema = z.object({
  dev: decimalString,
  ino: decimalString,
  uid: decimalString,
  gid: decimalString,
  mode: decimalString,
  size: decimalString,
  mtimeNs: decimalString,
  ctimeNs: decimalString,
}).strict();

type DriverFileIdentity = z.infer<typeof driverFileIdentitySchema>;

const driverSchema = z.object({
  path: z.string().refine((path) => path.startsWith("/"), "driver path must be absolute"),
  version: z.literal("0.19.3"),
  source: z.enum(["bundled", "environment", "user-local", "path"]),
  manifestSchema: z.literal("1"),
  fileIdentity: driverFileIdentitySchema,
}).strict();

const daemonSchema = z.object({
  socketPath: z.string().refine((path) => path.startsWith("/"), "socket path must be absolute"),
  pid: z.number().int().positive(),
  contractVersion: z.literal("0.6.0"),
  toolsListSchemaVersion: z.literal("1"),
  capabilityVersion: z.literal("1"),
  mcpProtocolVersion: z.literal("2025-06-18"),
}).strict();

const x11McpEnvironmentSchema = z.object({
  CUA_DRIVER_EMBEDDED: z.literal("1"),
  CUA_DRIVER_HOST_BUNDLE_ID: z.literal("com.helmryth.app"),
  CUA_DRIVER_RS_UPDATE_CHECK: z.literal("false"),
  CUA_DRIVER_RS_TELEMETRY_ENABLED: z.literal("false"),
}).strict();

const waylandMcpEnvironmentSchema = x11McpEnvironmentSchema.extend({
  CUA_DRIVER_RS_ENABLE_WAYLAND: z.literal("1"),
}).strict();

const doctorWarningSchema = z.object({
  label: z.string(),
  status: z.literal("warn"),
  message: z.string(),
  detail: z.string().optional(),
}).strict();

function mcpSchema(environment: typeof x11McpEnvironmentSchema | typeof waylandMcpEnvironmentSchema) {
  return z.object({
    command: z.string(),
    args: z.tuple([z.literal("mcp"), z.literal("--embedded"), z.literal("--socket"), z.string()]),
    env: environment,
  }).strict();
}

const descriptorCommon = {
  schemaVersion: z.literal(1),
  platform: z.literal("linux"),
  enabled: z.literal(true),
  status: z.literal("ready"),
  ownerPid: z.number().int().positive(),
  generation: z.string().regex(/^[0-9a-f-]{32,64}$/i),
  driver: driverSchema,
  daemon: daemonSchema,
  toolNames: z.array(z.string()).superRefine((names, context) => {
    for (const required of REQUIRED_LINUX_TOOLS) {
      if (!names.includes(required)) context.addIssue({ code: "custom", message: `missing tool ${required}` });
    }
  }),
  doctorWarnings: z.array(doctorWarningSchema),
};

const x11DescriptorSchema = z.object({
  ...descriptorCommon,
  mode: z.literal("linux-x11-supervised"),
  session: z.literal("x11"),
  mcp: mcpSchema(x11McpEnvironmentSchema),
}).strict();

const waylandDescriptorSchema = z.object({
  ...descriptorCommon,
  mode: z.literal("linux-wayland-gnome-supervised"),
  session: z.literal("wayland"),
  compositor: z.literal("gnome-mutter"),
  mcp: mcpSchema(waylandMcpEnvironmentSchema),
}).strict();

const linuxDescriptorSchema = z.discriminatedUnion("mode", [x11DescriptorSchema, waylandDescriptorSchema])
  .superRefine((descriptor, context) => {
    if (descriptor.mcp.command !== descriptor.driver.path) {
      context.addIssue({ code: "custom", path: ["mcp", "command"], message: "must match the certified driver" });
    }
    if (descriptor.mcp.args[3] !== descriptor.daemon.socketPath) {
      context.addIssue({ code: "custom", path: ["mcp", "args", 3], message: "must match the daemon socket" });
    }
  });

export type LinuxConnectionDescriptor = z.infer<typeof linuxDescriptorSchema>;

const legacyDescriptorSchema = z.object({
  mode: z.string().optional(),
  mcpCommand: z.string(),
  mcpArgs: z.array(z.string()).optional(),
  mcpEnv: z.record(z.string(), z.string()).optional(),
}).passthrough();

function legacyPlatform(platform: NodeJS.Platform): "darwin" | "win32" | null {
  if (platform === "darwin" || platform === "win32") return platform;
  return null;
}

function currentDriverFileIdentity(file: string): DriverFileIdentity {
  const stat = statSync(file, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameDriverFileIdentity(expected: DriverFileIdentity, actual: DriverFileIdentity): boolean {
  return DRIVER_FILE_IDENTITY_KEYS.every((key) => expected[key] === actual[key]);
}

function decodeLegacyDescriptor(value: JsonValue, platform: NodeJS.Platform): LocalComputerConnection | null {
  const supportedPlatform = legacyPlatform(platform);
  const parsed = legacyDescriptorSchema.safeParse(value);
  if (!supportedPlatform || !parsed.success || parsed.data.mode === "unavailable") return null;
  return {
    command: parsed.data.mcpCommand,
    args: parsed.data.mcpArgs ?? ["mcp"],
    env: parsed.data.mcpEnv ?? {},
    platform: supportedPlatform,
    scope: "local-computer",
  };
}

function parsedLinuxDescriptor(value: JsonValue): LinuxConnectionDescriptor | null {
  const parsed = linuxDescriptorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function decodeLinuxDescriptor(value: JsonValue): LocalComputerConnection | null {
  const descriptor = parsedLinuxDescriptor(value);
  if (!descriptor) return null;
  return {
    command: descriptor.driver.path,
    args: [...descriptor.mcp.args],
    env: { ...descriptor.mcp.env },
    platform: "linux",
    generation: descriptor.generation,
    scope: "local-computer",
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedPrivate(stat: Stats, uid: number): boolean {
  return (stat.uid === uid || stat.uid === 0) && (stat.mode & 0o077) === 0;
}

export function validateLinuxDescriptorRuntime(
  descriptorFile: string,
  value: JsonValue,
  {
    uid = process.getuid?.() ?? -1,
    isProcessAlive = processAlive,
  }: { uid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): boolean {
  const descriptor = parsedLinuxDescriptor(value);
  if (!descriptor) return false;
  try {
    const descriptorStat = lstatSync(descriptorFile);
    const descriptorDirectoryStat = lstatSync(dirname(descriptorFile));
    if (
      !descriptorStat.isFile() ||
      descriptorStat.isSymbolicLink() ||
      !ownedPrivate(descriptorStat, uid) ||
      !descriptorDirectoryStat.isDirectory() ||
      descriptorDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(descriptorDirectoryStat, uid)
    ) {
      return false;
    }

    const binaryPath = descriptor.driver.path;
    const socketPath = descriptor.daemon.socketPath;
    const binaryStat = statSync(binaryPath);
    const currentFileIdentity = currentDriverFileIdentity(binaryPath);
    const socketStat = lstatSync(socketPath);
    const socketDirectoryStat = lstatSync(dirname(socketPath));
    if (
      realpathSync(binaryPath) !== binaryPath ||
      !sameDriverFileIdentity(descriptor.driver.fileIdentity, currentFileIdentity) ||
      !binaryStat.isFile() ||
      (binaryStat.uid !== uid && binaryStat.uid !== 0) ||
      (binaryStat.mode & 0o111) === 0 ||
      (binaryStat.mode & 0o022) !== 0 ||
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      !ownedPrivate(socketStat, uid) ||
      !socketDirectoryStat.isDirectory() ||
      socketDirectoryStat.isSymbolicLink() ||
      !ownedPrivate(socketDirectoryStat, uid) ||
      !isProcessAlive(descriptor.ownerPid) ||
      !isProcessAlive(descriptor.daemon.pid)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function readCuaConnection({
  platform = process.platform,
  userData = process.env.HELMRYTH_USER_DATA,
  home = homedir(),
  validateLinuxRuntime = validateLinuxDescriptorRuntime,
}: {
  platform?: NodeJS.Platform;
  userData?: string;
  home?: string;
  validateLinuxRuntime?: (file: string, value: JsonValue) => boolean;
} = {}): LocalComputerConnection | null {
  const candidates = userData ? [join(userData, "cua-connection.json")] : [];
  if (platform === "darwin") {
    // Legacy/dev fallback. Packaged Electron passes its exact userData path.
    for (const directory of ["Helmryth", "helmryth"]) {
      candidates.push(join(home, "Library", "Application Support", directory, "cua-connection.json"));
    }
  }

  for (const file of new Set(candidates)) {
    try {
      const value = parseJson(readFileSync(file, "utf8"));
      if (platform === "linux") {
        const decoded = decodeLinuxDescriptor(value);
        if (decoded && validateLinuxRuntime(file, value)) return decoded;
      } else {
        const decoded = decodeLegacyDescriptor(value, platform);
        if (decoded) return decoded;
      }
    } catch {
      // Missing, invalid, tampered, or stale descriptors are unavailable.
    }
  }
  return null;
}
