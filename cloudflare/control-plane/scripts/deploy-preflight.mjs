#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const cloudflareIdSchema = z.string().regex(/^[0-9a-f]{32}$/i);
const databaseIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const routeSchema = z.object({
  pattern: z.string().min(1),
  custom_domain: z.boolean().optional(),
  zone_name: z.string().optional(),
}).passthrough();
const productionConfigSchema = z.object({
  name: z.string().min(1),
  workers_dev: z.boolean(),
  routes: z.array(routeSchema),
  vars: z.object({
    HELMRYTH_REGISTRY_ORIGIN: z.string(),
    HELMRYTH_EMAIL_FROM: z.string(),
    HELMRYTH_NODE_ORIGINS: z.string(),
    CLOUDFLARE_ACCOUNT_ID: z.string(),
    CLOUDFLARE_ZONE_ID: z.string(),
    HELMRYTH_REACH_HOST_SUFFIX: z.string(),
    HELMRYTH_REACH_ORIGIN: z.string(),
  }).passthrough(),
  secrets: z.object({ required: z.array(z.string()) }),
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() }).passthrough()),
  send_email: z.array(z.object({
    name: z.string(),
    allowed_sender_addresses: z.array(z.string()),
  }).passthrough()),
}).passthrough();

const ALL_ZERO_IDENTIFIER = /^0+(?:-0+)*$/;
const RESERVED_HOST = /(?:^|\.)(?:workers\.dev|localhost|local|invalid|test|example|example\.com|example\.net|example\.org)$/i;

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

function hasWildcard(value) {
  return value.includes("*");
}

function isReservedHost(hostname) {
  return RESERVED_HOST.test(hostname) || isIP(hostname) !== 0;
}

function parseExactHttpsOrigin(value, label, errors, options = {}) {
  const { allowReservedHost = false } = options;
  if (!value) {
    errors.push(`${label} must be set`);
    return null;
  }
  if (hasWildcard(value)) {
    errors.push(`${label} must not use wildcard hosts`);
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${label} must be a valid HTTPS origin`);
    return null;
  }
  if (url.protocol !== "https:") errors.push(`${label} must use HTTPS`);
  if (value !== url.origin) errors.push(`${label} must be an origin without a path, query, or fragment`);
  if (url.username || url.password) errors.push(`${label} must not contain credentials`);
  if (url.port) errors.push(`${label} must use the standard HTTPS port`);
  if (!allowReservedHost && isReservedHost(url.hostname.toLowerCase())) {
    errors.push(`${label} must use an owned hostname, not Workers.dev, localhost, an IP, or a reserved placeholder`);
  }
  return url;
}

function parseExactLoopbackOrigin(value, errors) {
  if (!value) {
    errors.push("vars.HELMRYTH_REACH_ORIGIN must declare the exact loopback origin");
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push("vars.HELMRYTH_REACH_ORIGIN must be a valid loopback HTTP origin");
    return null;
  }
  if (url.protocol !== "http:") errors.push("vars.HELMRYTH_REACH_ORIGIN must use HTTP");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    errors.push("vars.HELMRYTH_REACH_ORIGIN must target an exact loopback host");
  }
  if (value !== url.origin) {
    errors.push("vars.HELMRYTH_REACH_ORIGIN must be an origin without a path, query, or fragment");
  }
  if (url.username || url.password) errors.push("vars.HELMRYTH_REACH_ORIGIN must not contain credentials");
  return url;
}

function validateReachSuffix(value, errors) {
  if (!value) {
    errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must be set");
    return;
  }
  const lowered = value.toLowerCase();
  if (value !== lowered) errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must be lowercase");
  if (hasWildcard(value)) errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must not use wildcards");
  if (value.endsWith(".")) errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must not end with a dot");
  const labels = lowered.split(".");
  if (
    labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must be a valid DNS suffix");
    return;
  }
  if (isReservedHost(lowered)) {
    errors.push("vars.HELMRYTH_REACH_HOST_SUFFIX must use an owned DNS suffix");
  }
}

function parseRouteHost(route, errors, index) {
  if (route.custom_domain !== true) {
    errors.push(`routes[${index}] must be a custom_domain entry`);
  }
  if (hasWildcard(route.pattern)) {
    errors.push(`routes[${index}].pattern must not use wildcards`);
    return null;
  }
  let url;
  try {
    url = new URL(`https://${route.pattern}`);
  } catch {
    errors.push(`routes[${index}].pattern must be a bare hostname`);
    return null;
  }
  if (url.hostname !== route.pattern || url.pathname !== "/" || url.search || url.hash) {
    errors.push(`routes[${index}].pattern must be a bare hostname`);
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (isReservedHost(host)) {
    errors.push(`routes[${index}].pattern must use an owned hostname`);
  }
  return host;
}

function parseEmail(value, label, errors) {
  const parsed = z.email().safeParse(value);
  if (!parsed.success) {
    errors.push(`${label} must be a valid email address`);
    return null;
  }
  const [, domain = ""] = value.split("@");
  const hostname = domain.toLowerCase();
  if (!hostname || isReservedHost(hostname)) {
    errors.push(`${label} must use a verified sender domain you control`);
  }
  return parsed.data;
}

function parseNodeOrigins(value, errors) {
  if (!value) {
    errors.push("vars.HELMRYTH_NODE_ORIGINS must include at least one exact HTTPS origin");
    return [];
  }
  const seen = new Set();
  const origins = [];
  for (const raw of value.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const origin = parseExactHttpsOrigin(raw, "vars.HELMRYTH_NODE_ORIGINS", errors);
    if (!origin) continue;
    if (seen.has(origin.origin)) continue;
    seen.add(origin.origin);
    origins.push(origin);
  }
  if (!origins.length) {
    errors.push("vars.HELMRYTH_NODE_ORIGINS must include at least one exact HTTPS origin");
  }
  return origins;
}

export function collectProductionConfigErrors(input) {
  const parsed = productionConfigSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `Invalid production config at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const config = parsed.data;
  const errors = [];

  if (config.workers_dev !== false) errors.push("workers_dev must be false for production");
  if (config.routes.length !== 1) errors.push("Production requires exactly one custom hostname route");

  const routeHosts = config.routes.map((route, index) => parseRouteHost(route, errors, index)).filter(Boolean);
  const registryOrigin = parseExactHttpsOrigin(config.vars.HELMRYTH_REGISTRY_ORIGIN, "vars.HELMRYTH_REGISTRY_ORIGIN", errors);
  if (registryOrigin && routeHosts.length === 1 && routeHosts[0] !== registryOrigin.hostname.toLowerCase()) {
    errors.push("The production route hostname must match HELMRYTH_REGISTRY_ORIGIN exactly");
  }

  const sender = parseEmail(config.vars.HELMRYTH_EMAIL_FROM, "vars.HELMRYTH_EMAIL_FROM", errors);
  parseNodeOrigins(config.vars.HELMRYTH_NODE_ORIGINS, errors);
  validateReachSuffix(config.vars.HELMRYTH_REACH_HOST_SUFFIX, errors);
  parseExactLoopbackOrigin(config.vars.HELMRYTH_REACH_ORIGIN, errors);

  if (!cloudflareIdSchema.safeParse(config.vars.CLOUDFLARE_ACCOUNT_ID).success) {
    errors.push("vars.CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID");
  } else if (ALL_ZERO_IDENTIFIER.test(config.vars.CLOUDFLARE_ACCOUNT_ID)) {
    errors.push("vars.CLOUDFLARE_ACCOUNT_ID must not be all zeroes");
  }

  if (!cloudflareIdSchema.safeParse(config.vars.CLOUDFLARE_ZONE_ID).success) {
    errors.push("vars.CLOUDFLARE_ZONE_ID must be a 32-character Cloudflare zone ID");
  } else if (ALL_ZERO_IDENTIFIER.test(config.vars.CLOUDFLARE_ZONE_ID)) {
    errors.push("vars.CLOUDFLARE_ZONE_ID must not be all zeroes");
  }

  if (!config.secrets.required.includes("HELMRYTH_REGISTRY_AUTH_SECRET")) {
    errors.push("HELMRYTH_REGISTRY_AUTH_SECRET must be declared as a required Wrangler secret");
  }
  if (!config.secrets.required.includes("CLOUDFLARE_API_TOKEN")) {
    errors.push("CLOUDFLARE_API_TOKEN must be declared as a required Wrangler secret");
  }

  const database = config.d1_databases.find((entry) => entry.binding === "REGISTRY_DB");
  if (!database) errors.push("REGISTRY_DB must be configured");
  else if (ALL_ZERO_IDENTIFIER.test(database.database_id)) {
    errors.push("REGISTRY_DB D1 database ID must not be all zeroes");
  } else if (!databaseIdSchema.safeParse(database.database_id).success) {
    errors.push("REGISTRY_DB D1 database ID must be a valid UUID");
  }

  const senderBinding = config.send_email.find((entry) => entry.name === "REGISTRY_EMAIL");
  if (!senderBinding) {
    errors.push("REGISTRY_EMAIL send_email binding must be configured");
  } else if (sender) {
    if (senderBinding.allowed_sender_addresses.length !== 1) {
      errors.push("REGISTRY_EMAIL must allow exactly one verified sender address");
    }
    const [allowedSender = ""] = senderBinding.allowed_sender_addresses;
    if (allowedSender !== sender) {
      errors.push("REGISTRY_EMAIL allowed_sender_addresses must exactly match HELMRYTH_EMAIL_FROM");
    }
    parseEmail(allowedSender, "send_email.REGISTRY_EMAIL", errors);
  }

  return errors;
}

export function readProductionConfig(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function cliConfigPath(argv) {
  const index = argv.indexOf("--config");
  return resolve(index === -1 ? "cloudflare/control-plane/wrangler.jsonc" : (argv[index + 1] ?? ""));
}

function main() {
  const configPath = cliConfigPath(process.argv.slice(2));
  let config;
  try {
    config = readProductionConfig(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[registry-preflight] Could not read ${configPath}: ${message}`);
    process.exitCode = 1;
    return;
  }
  const errors = collectProductionConfigErrors(config);
  if (errors.length) {
    console.error(`[registry-preflight] Refusing production deploy from ${configPath}:`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[registry-preflight] Production config is route-locked and secret-complete: ${configPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) main();
