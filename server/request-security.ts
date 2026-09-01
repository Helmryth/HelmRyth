import type { IncomingHttpHeaders } from "node:http";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RendererBoundaryOptions {
  port: number;
  staticDir: string | null;
  uiOrigin?: string;
  uiPort?: string;
}

/**
 * Resolve the one renderer origin trusted by the loopback control plane.
 *
 * Packaged builds are same-origin and must use the core's exact IPv4 address.
 * Source development is split across Vite and the core, so it trusts the
 * explicitly configured Vite origin (or the documented IPv4 development
 * default). This is intentionally an exact origin, never a loopback wildcard.
 */
export function rendererOrigin(options: RendererBoundaryOptions): string {
  const packagedOrigin = `http://127.0.0.1:${options.port}`;
  if (options.staticDir) {
    if (options.uiOrigin !== undefined && options.uiOrigin !== packagedOrigin) {
      throw new Error(`HELMRYTH_UI_ORIGIN must be ${packagedOrigin} in packaged mode`);
    }
    return packagedOrigin;
  }

  const input = options.uiOrigin ?? `http://127.0.0.1:${options.uiPort || "5199"}`;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("HELMRYTH_UI_ORIGIN must be an exact http(s) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== input
  ) {
    throw new Error("HELMRYTH_UI_ORIGIN must be an exact http(s) origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

/** The public core binds only here; accepting aliases would reopen DNS rebinding. */
export function exactCoreAuthority(port: number): string {
  return `127.0.0.1:${port}`;
}

export function requestHasExactCoreAuthority(headers: IncomingHttpHeaders, port: number): boolean {
  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  return host === exactCoreAuthority(port);
}

/**
 * Browser requests must name the exact renderer origin. Native/CLI clients do
 * not send Origin and remain supported; they are not subject to browser CSRF.
 */
export function requestHasTrustedRendererOrigin(
  headers: IncomingHttpHeaders,
  trustedRendererOrigin: string,
): boolean {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  return origin === undefined || origin === trustedRendererOrigin;
}

export function isApplicationJson(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value;
  return String(header ?? "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

/** Raw image upload is the sole public mutation with a non-JSON request body. */
export function publicMutationRequiresJson(method: string, path: string): boolean {
  return (
    MUTATION_METHODS.has(method.toUpperCase()) &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/internal/") &&
    path !== "/api/attachments"
  );
}
