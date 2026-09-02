import { z } from "zod";

import { accountSession, createAuth } from "./auth";
import { readConfig, type RegistryConfig } from "./config";
import { errorResponse, HTTPError, json, preflight, secureResponse, withBoundedRequestBody } from "./http";
import { limitedOTPResponse } from "./otp-rate-limit";
import type { CloudflareFetch } from "./cloudflare-api";
import {
  cleanupReachForNode,
  deleteManagedReach,
  getManagedReach,
  provisionManagedReach,
  sweepManagedReachCleanup,
} from "./reaches";
import {
  createNode,
  nodeSelf,
  listNodes,
  revokeNode,
  rotateNodeCredential,
} from "./nodes";

const ROTATE_ROUTE = /^\/v1\/nodes\/([^/]+)\/credentials\/rotate$/;
const NODE_ROUTE = /^\/v1\/nodes\/([^/]+)$/;

const BETTER_AUTH_ERROR_CODES = new Map([
  ["INVALID_EMAIL", "invalid_email"],
  ["INVALID_OTP", "invalid_otp"],
  ["OTP_EXPIRED", "otp_expired"],
  ["TOO_MANY_ATTEMPTS", "rate_limited"],
  ["USER_NOT_FOUND", "invalid_otp"],
  ["VALIDATION_ERROR", "invalid_request"],
]);
const betterAuthErrorSchema = z.object({ code: z.string() }).loose();

function authStatusErrorCode(status: number): string {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  return "request_failed";
}

async function canonicalAuthResponse(response: Response): Promise<Response> {
  if (response.status >= 500) return errorResponse(500, "internal_error");
  if (response.status < 400 || response.status > 499) return response;

  // Better Auth error bodies are dependency-owned and may contain prose or
  // change shape between releases (its rate limiter currently returns only a
  // `message`). Publish only Helmryth's stable, lowercase error contract.
  const payload: unknown = await response.json().catch(() => null);
  const parsed = betterAuthErrorSchema.safeParse(payload);
  const dependencyCode = parsed.success ? parsed.data.code : "";
  const code = BETTER_AUTH_ERROR_CODES.get(dependencyCode) ?? authStatusErrorCode(response.status);
  return errorResponse(response.status, code);
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: RegistryConfig,
  requestId: string,
  cloudflareFetch: CloudflareFetch,
) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request, config);

  if (url.pathname.startsWith("/api/auth/")) {
    const limited = await limitedOTPResponse(request, env);
    if (limited) return limited;
    const response = await createAuth(env, ctx, config, requestId).handler(request);
    return canonicalAuthResponse(response);
  }

  const auth = createAuth(env, ctx, config, requestId);
  if (request.method === "GET" && url.pathname === "/v1/account") {
    const session = await accountSession(request, auth);
    if (!session) throw new HTTPError(401, "unauthorized");
    return json({
      account: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/nodes") {
    return listNodes(request, env, auth);
  }
  if (request.method === "POST" && url.pathname === "/v1/nodes") {
    return createNode(request, env, auth);
  }
  if (request.method === "GET" && url.pathname === "/v1/nodes/self") {
    return nodeSelf(request, env);
  }
  if (url.pathname === "/v1/nodes/self/reach") {
    if (request.method === "GET") return getManagedReach(request, env);
    if (request.method === "POST") {
      return provisionManagedReach(request, env, config, cloudflareFetch, requestId);
    }
    if (request.method === "DELETE") {
      return deleteManagedReach(request, env, config, cloudflareFetch, requestId);
    }
  }

  const rotate = url.pathname.match(ROTATE_ROUTE);
  if (request.method === "POST" && rotate) {
    return rotateNodeCredential(request, rotate[1], env, auth);
  }
  const node = url.pathname.match(NODE_ROUTE);
  if (request.method === "DELETE" && node) {
    const response = await revokeNode(request, node[1], env, auth);
    ctx.waitUntil(cleanupReachForNode(
      env,
      config,
      node[1],
      cloudflareFetch,
      requestId,
    ).catch(() => {
      console.error(JSON.stringify({
        message: "revoked node reach cleanup scheduling failed",
        requestId,
        errorCode: "reach_internal",
      }));
    }));
    return response;
  }
  return errorResponse(404, "not_found");
}

export function createRegistry(cloudflareFetch: CloudflareFetch = fetch) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        try {
          readConfig(env);
        } catch {
          return secureResponse(errorResponse(503, "misconfigured"), request, null, requestId);
        }
        return secureResponse(json({ ok: true, service: "helmryth-registry" }), request, null, requestId);
      }

      let config: RegistryConfig | null = null;
      try {
        config = readConfig(env);
        const origin = request.headers.get("origin");
        if (origin && !config.nodeOrigins.has(origin)) {
          return secureResponse(errorResponse(403, "origin_not_allowed"), request, config, requestId);
        }
        const boundedRequest = await withBoundedRequestBody(request);
        return secureResponse(
          await route(boundedRequest, env, ctx, config, requestId, cloudflareFetch),
          request,
          config,
          requestId,
        );
      } catch (error) {
        if (error instanceof HTTPError) {
          return secureResponse(errorResponse(error.status, error.code), request, config, requestId);
        }
        console.error(JSON.stringify({ message: "request failed", requestId }));
        return secureResponse(errorResponse(500, "internal_error"), request, config, requestId);
      }
    },
    scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
      const requestId = crypto.randomUUID();
      ctx.waitUntil((async () => {
        try {
          const config = readConfig(env);
          await sweepManagedReachCleanup(env, config, cloudflareFetch, requestId);
        } catch {
          console.error(JSON.stringify({
            message: "managed reach cleanup sweep failed",
            requestId,
            errorCode: "reach_internal",
          }));
        }
      })());
    },
  } satisfies ExportedHandler<Env>;
}

export default createRegistry();
