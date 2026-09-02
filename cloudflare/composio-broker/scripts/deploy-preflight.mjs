#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const identifierSchema = z.union([z.string(), z.number()]).transform(String);
const routeSchema = z.union([
  z.string(),
  z.object({ pattern: z.string(), custom_domain: z.boolean().optional(), zone_name: z.string().optional() }).passthrough(),
]);
const productionConfigSchema = z.object({
  name: z.string().min(1),
  workers_dev: z.boolean(),
  routes: z.array(routeSchema),
  vars: z.object({
    HELMRYTH_CONDUIT_ENROLLMENT_MODE: z.string(),
    HELMRYTH_CONDUIT_ORIGIN: z.string().optional(),
    COMPOSIO_API_BASE: z.string().optional(),
    COMPOSIO_TOOLKIT_BASE: z.string().optional(),
  }).passthrough(),
  secrets: z.object({ required: z.array(z.string()) }),
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() }).passthrough()),
  ratelimits: z.array(z.object({ name: z.string(), namespace_id: identifierSchema }).passthrough()),
}).passthrough();

const ALL_ZERO_IDENTIFIER = /^0+(?:-0+)*$/;
const RESERVED_HOST = /(?:^|\.)(?:workers\.dev|localhost|invalid|test|example\.(?:com|net|org))$/i;

function parseOrigin(value, errors) {
  if (!value) {
    errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must declare the HTTPS owned origin");
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must be a valid URL");
    return null;
  }
  if (url.protocol !== "https:") errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must use HTTPS");
  if (value !== url.origin) errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must be an origin without a path, query, or fragment");
  if (url.username || url.password) errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must not contain credentials");
  if (url.port) errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must use the standard HTTPS port");
  if (RESERVED_HOST.test(url.hostname) || isIP(url.hostname) !== 0) {
    errors.push("vars.HELMRYTH_CONDUIT_ORIGIN must use an owned hostname, not Workers.dev, localhost, an IP, or a reserved placeholder");
  }
  return url;
}

function routeHostname(route) {
  const pattern = routeSchema.parse(route).pattern ?? route;
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\/$/, "");
  if (!host || host.includes("/") || host.startsWith("*.")) return null;
  return host.toLowerCase();
}

export function collectProductionConfigErrors(input) {
  const parsed = productionConfigSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `Invalid production config at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const config = parsed.data;
  const errors = [];

  if (config.workers_dev !== false) errors.push("workers_dev must be false for production");
  if (config.vars.HELMRYTH_CONDUIT_ENROLLMENT_MODE !== "closed") {
    errors.push("HELMRYTH_CONDUIT_ENROLLMENT_MODE enrollment mode must be closed for production");
  }

  const origin = parseOrigin(config.vars.HELMRYTH_CONDUIT_ORIGIN, errors);
  const routeHosts = config.routes.map(routeHostname).filter(Boolean);
  if (!routeHosts.length) errors.push("Production requires an explicit owned route or custom domain");
  if (origin && !routeHosts.includes(origin.hostname.toLowerCase())) {
    errors.push("The production route hostname must match HELMRYTH_CONDUIT_ORIGIN");
  }

  const database = config.d1_databases.find((entry) => entry.binding === "CONDUIT_DB");
  if (!database) errors.push("CONDUIT_DB must be configured");
  else if (ALL_ZERO_IDENTIFIER.test(database.database_id)) errors.push("CONDUIT_DB D1 database ID must not be all zeroes");

  for (const binding of ["NODE_ENROLLMENT_LIMITER", "CONDUIT_SESSION_LIMITER"]) {
    const limiter = config.ratelimits.find((entry) => entry.name === binding);
    if (!limiter) errors.push(`${binding} must be configured`);
    else if (ALL_ZERO_IDENTIFIER.test(limiter.namespace_id)) errors.push(`${binding} namespace ID must not be all zeroes`);
  }

  if (!config.secrets.required.includes("COMPOSIO_API_KEY")) {
    errors.push("COMPOSIO_API_KEY must be declared as a required Wrangler secret");
  }
  for (const [name, value] of [
    ["COMPOSIO_API_BASE", config.vars.COMPOSIO_API_BASE],
    ["COMPOSIO_TOOLKIT_BASE", config.vars.COMPOSIO_TOOLKIT_BASE],
  ]) {
    if (!value?.startsWith("https://")) errors.push(`${name} must use HTTPS`);
  }

  return errors;
}

function stripJsonComments(source) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quoted) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quoted = false;
      continue;
    }
    if (current === '"') {
      quoted = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

export function readProductionConfig(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function cliConfigPath(argv) {
  const index = argv.indexOf("--config");
  return resolve(index === -1 ? "cloudflare/composio-broker/wrangler.jsonc" : (argv[index + 1] ?? ""));
}

function main() {
  const configPath = cliConfigPath(process.argv.slice(2));
  let config;
  try {
    config = readProductionConfig(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[conduit-preflight] Could not read ${configPath}: ${message}`);
    process.exitCode = 1;
    return;
  }
  const errors = collectProductionConfigErrors(config);
  if (errors.length) {
    console.error(`[conduit-preflight] Refusing production deploy from ${configPath}:`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[conduit-preflight] Production config is closed and route-owned: ${configPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) main();
