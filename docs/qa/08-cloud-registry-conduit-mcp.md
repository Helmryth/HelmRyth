# Cloud, Registry, Conduit, and MCP QA Matrix

This document covers Helmryth's hosted identity and capability plane as of Sunday, August 30, 2026:

- Registry Worker in `cloudflare/control-plane`
- Reach provisioning and cleanup against Cloudflare Tunnel and DNS
- Conduit Worker in `cloudflare/composio-broker`
- Desktop and server-side clients that consume those contracts
- MCP and proxy entry points in `scripts/mcp-server.ts`, `server/mcp-bridge.ts`, `server/container-mcp.ts`, `server/vps-container-mcp.ts`, `server/connector-proxy.ts`, `server/permission-proxy.ts`, `server/drivers/agents-proxy.ts`, `server/drivers/dweb-proxy.ts`, and `server/drivers/phone-proxy.ts`

## Resolved contract drifts

Status: resolved on Sunday, August 30, 2026.

The original stop-ship finding is preserved below because it drove the migration checks in this document. Those mismatches are no longer present in the current source tree.

1. Registry Worker exposes `/v1/account`, `/v1/nodes`, `/v1/nodes/self`, and `/v1/nodes/self/reach`, and `electron/registry-client.mjs` now calls those exact routes.
2. Conduit Worker exposes `POST /v1/nodes`, `GET /v1/self`, and issues `hry_<64 hex>` tokens, and `electron/managed-composio.mjs` now uses those exact routes and token shape.
3. `electron/companion-account-service.mjs` now maps current `node_*` and `reach_*` error codes, including `node_limit_reached`, `node_exists`, `reach_busy`, and `reach_cleanup_pending`.

### Original finding preserved for audit history

1. Registry Worker had moved to `/v1/account`, `/v1/nodes`, `/v1/nodes/self`, and `/v1/nodes/self/reach`, while `electron/registry-client.mjs` still called `/v1/me`, `/v1/installations`, `/v1/installations/self`, and `/v1/installations/self/endpoint`.
2. Conduit Worker had moved to `POST /v1/nodes`, `GET /v1/self`, and `hry_`-prefixed tokens, while `electron/managed-composio.mjs` still called `/v1/installations`, `GET /v1/me`, and accepted only bare 64-hex tokens.
3. `electron/companion-account-service.mjs` had still mapped older `installation_*` and `endpoint_*` names instead of current `node_*` and `reach_*` codes.

### Migration table

| Surface | Old client contract | Current aligned contract | Current source evidence |
|---|---|---|---|
| Registry account lookup | `/v1/me` | `/v1/account` | `electron/registry-client.mjs`, `electron/registry-client.test.mjs` |
| Registry node list/create | `/v1/installations` | `/v1/nodes` | `electron/registry-client.mjs`, `cloudflare/control-plane/src/index.ts` |
| Registry node self | `/v1/installations/self` | `/v1/nodes/self` | `electron/registry-client.mjs`, `electron/registry-client.test.mjs` |
| Registry rotate | `/v1/installations/:id/credentials/rotate` | `/v1/nodes/:id/credentials/rotate` | `electron/registry-client.mjs`, `cloudflare/control-plane/src/index.ts` |
| Registry hosted endpoint | `/v1/installations/self/endpoint` | `/v1/nodes/self/reach` | `electron/registry-client.mjs`, `cloudflare/control-plane/src/index.ts` |
| Registry revoke | `/v1/installations/:id` | `/v1/nodes/:id` | `electron/registry-client.mjs`, `electron/registry-client.test.mjs` |
| Conduit self check | `/v1/me` | `/v1/self` | `electron/managed-composio.mjs`, `electron/managed-composio.test.mjs` |
| Conduit enroll | `/v1/installations` | `/v1/nodes` | `electron/managed-composio.mjs`, `cloudflare/composio-broker/src/index.ts` |
| Conduit token regex | bare `64` hex | `hry_<64 hex>` | `electron/managed-composio.mjs`, `cloudflare/composio-broker/src/index.ts` |
| Friendly hosted errors | `installation_*`, `endpoint_*` | `node_*`, `reach_*` | `electron/companion-account-service.mjs`, `electron/companion-account-service.test.mjs` |

### Resolution evidence

Focused verification completed on Sunday, August 30, 2026:

- Electron hosted-contract suite: `51/51` passing from `electron/registry-client.test.mjs`, `electron/managed-composio.test.mjs`, and `electron/companion-account-service.test.mjs`
- Registry Worker suite: `43/43` passing from `cloudflare/control-plane/test/registry.test.ts` and `cloudflare/control-plane/test/managed-reaches.test.ts`
- Conduit Worker suite: `10/10` passing from `cloudflare/composio-broker/src/index.test.ts`
- Repository type check: `pnpm typecheck` passed
- Repository build: `pnpm build` passed
- Brand residue gate: `pnpm check:brand` passed
- Registry dry-run: `pnpm registry:dry-run` passed and still showed local-safe placeholder bindings
- Conduit dry-run: `pnpm conduit:dry-run` passed and still showed local-safe placeholder bindings

Hosted-release sign-off no longer blocks on route drift, but it still blocks on the external/live-deployment prerequisites called out under `OPS-001` through `OPS-005`.

## Coverage notes

- Most surfaces here are HTTP APIs, JSON-RPC stdio bridges, or loopback-only gateways, so mouse, keyboard, focus order, and screen-reader assertions are not applicable to the transport itself.
- The only rendered surfaces indirectly owned here are the secure connection, cadence, credential, and companion-state cards opened by the desktop shell. When `MCP-006`, `MCP-008`, `DRF-003`, or `DRF-004` is run manually through the app, retain screenshots at 390px, 768px, and 1440px widths in the owning UI evidence bundle.
- Every consequential action in this domain must be proven fail-closed on origin, credential class, redirect handling, secret redaction, or placeholder configuration.

## Route and tool count comparison

| Surface | Source of truth | Source count | Coverage in this doc |
|---|---|---:|---|
| Registry public HTTP | `cloudflare/control-plane/src/index.ts` | 10 direct app method+path pairs, plus 3 Better Auth routes; generic `OPTIONS` CORS handling and scheduled cleanup sit outside that direct-route count | `REG-001` through `REG-012`, `RCH-001` through `RCH-008`, `OPS-001` |
| Conduit public HTTP | `cloudflare/composio-broker/src/index.ts` | 10 method+path pairs | `CON-001` through `CON-011`, `DRF-002`, `OPS-002` |
| Internal harness HTTP used by proxies | `server/index.ts` | 10 routes/path families | `MCP-006`, `MCP-008` |
| MCP CLI surface | `scripts/mcp-server.ts` | 19 tools, 0 resources, 0 prompts | `MCP-001` |
| Computer proxy | `server/computer-proxy.ts` | 16 tools | `MCP-002` |
| Permission proxy | `server/permission-proxy.ts` | 2 tools | `MCP-007` |
| Agents proxy | `server/drivers/agents-proxy.ts` | 10 tools | `MCP-008` |
| dweb proxy | `server/drivers/dweb-proxy.ts` | 4 tools | `MCP-009` |
| Phone proxy | `server/drivers/phone-proxy.ts` | 10 tools | `MCP-010` |
| Resource / prompt methods across reviewed proxies | same files above | 0 implemented methods | `MCP-001` through `MCP-010` negative assertions |

## Architecture risks to keep visible

- Registry request bodies are globally bounded to 16 KB before JSON parsing or Better Auth handling. Conduit MCP request bodies are bounded to 2 MB, and upstream connector responses are bounded to 20 MB. Boundary tests here are P0 because they protect memory use and secret-bearing payloads.
- Registry explicitly separates account bearer sessions from node credentials by prefix and route family. Conduit also separates enrolled node tokens from Composio session credentials. Credential-class confusion is a release blocker.
- Reach cleanup intentionally retains provider identifiers after partial failure. That is correct for operational safety, but it means tests must prove idempotent retry, manual-attention thresholds, and provider-identity conflict handling.
- Conduit capability inventory walks paginated connected-account and toolkit lists with hard page ceilings. Large-account and repeated-cursor cases are query-shape risks, not edge trivia.
- `server/control-client.ts` caches hold state for 750 ms and fails open when the loopback broker is unavailable. That is a product choice, not a security boundary; tests must verify both the fail-open behavior and the user-visible refusal path when the broker is healthy.

## Registry and auth compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| REG-001 | Registry Worker `/healthz` | `GET /healthz` | Local Worker or deployed Worker with config loaded | Call without `Origin`, then with a known-good config and a deliberately bad secret | `200` with exact body `{"ok":true,"service":"helmryth-registry"}` and `cache-control: no-store`; misconfigured env returns `503 {"error":"misconfigured"}` with no leaked config text | Never emit `*` CORS; no auth required; redirect/network failures fail closed in callers | `cloudflare/control-plane/test/registry.test.ts` health tests; manual `curl -i` capture | P0 |
| REG-002 | Registry Worker CORS boundary | `OPTIONS /v1/nodes`, `Origin` handling on any route | Exact `HELMRYTH_NODE_ORIGINS` set; one allowed origin and one hostile origin | Send preflight from allowed and disallowed origins; repeat authenticated `GET /v1/account` with both | Allowed origin gets `204` with exact `allow-origin`, `allow-methods`, `allow-headers`, and `vary: Origin`; hostile origin gets `403 origin_not_allowed`; normal responses only echo exact allowed origin | Reject wildcard origins, unsupported headers, unsupported methods, missing requested method, and origin spoofing | `cloudflare/control-plane/test/registry.test.ts` CORS tests; manual browser network capture | P0 |
| REG-003 | Better Auth OTP send | `POST /api/auth/email-otp/send-verification-otp` | Valid `REGISTRY_EMAIL` binding; known and unknown emails | Send OTP request for unknown email, then known email | Both calls return the same enumeration-safe success payload and `no-store`; DB stores hashed OTP only; email logs stay redacted | Per-recipient rate limit should freeze OTP row after the cap; Better Auth message-only 429 must be canonicalized to `rate_limited` | `cloudflare/control-plane/test/registry.test.ts` OTP send tests | P0 |
| REG-004 | Better Auth OTP verification and session issue | `POST /api/auth/sign-in/email-otp` | Fresh OTP for a normalized email | Verify valid OTP, read `set-auth-token`, then call `GET /v1/account` with the signed bearer | Signed bearer works; raw Better Auth JSON token does not; response body exposes only stable account fields | Invalid, expired, replayed, malformed, or padded OTPs are rejected with canonical public codes; sign-out invalidates session | `cloudflare/control-plane/test/registry.test.ts` verify/replay tests; `electron/registry-client.test.mjs` signed bearer tests | P0 |
| REG-005 | Account session boundary | `GET /v1/account` | One signed account bearer, one node credential, one arbitrary `hry_` token | Call with each credential class | Only the signed non-`hry_` bearer succeeds; node credential and conduit-style token return `401 unauthorized` | Verify missing bearer, malformed bearer, stale bearer, and account token on node routes all fail closed | `cloudflare/control-plane/test/registry.test.ts` bearer-boundary tests | P0 |
| REG-006 | Node inventory | `GET /v1/nodes` | Signed account bearer; zero nodes, then one or more nodes | List before and after enrollment | Results are owner-scoped, sorted, capped at 100 active nodes, and omit raw credential material | Cross-account reads must never surface foreign node rows; revoked nodes disappear from the active list | `cloudflare/control-plane/test/registry.test.ts` owner-isolation tests | P1 |
| REG-007 | Node enrollment | `POST /v1/nodes` with `{name, clientInstanceId, platform, appVersion}` | Signed account bearer; valid platform and client instance ID | Create a node and capture `credential`, `credentialExpiresAt`, and returned node metadata | `201`; node row stored; raw node credential returned once; D1 stores only SHA-256 hash and lookup ID; `lastSeenAt` starts null | Reject duplicate active `clientInstanceId` per owner, malformed platform/name/version, extra fields, oversize body, and per-account hourly creation limit | `cloudflare/control-plane/test/registry.test.ts` enrollment/input-limit tests | P0 |
| REG-008 | Node self resolution | `GET /v1/nodes/self` | Valid node credential from `REG-007` | Call with current credential, then expired/revoked credential | Current credential returns node metadata and `credentialExpiresAt`; `last_seen_at` and `last_used_at` advance; expired or revoked credential gets `401` | Account bearer on this route must fail; timing-safe hash compare must reject same lookup ID with wrong secret | `cloudflare/control-plane/test/registry.test.ts` node-self tests | P0 |
| REG-009 | Credential rotation | `POST /v1/nodes/:id/credentials/rotate` | Signed owning account bearer; enrolled node | Rotate credential and immediately test old and new credentials on `/v1/nodes/self` | `201`; old active credential revoked; new credential works; node timestamps update | Enforce one-minute cooldown and conflict serialization; non-owner and malformed node ID return not found/unauthorized without leaking ownership | `cloudflare/control-plane/test/registry.test.ts` rotation tests | P0 |
| REG-010 | Node revocation | `DELETE /v1/nodes/:id` | Signed owning account bearer; node with optional Reach | Delete once, delete again, then probe `/v1/nodes/self` with latest credential | First and repeat delete return `204`; credentials are revoked before asynchronous Reach cleanup; node self becomes `401` | Non-owner delete must not reveal existence; cleanup scheduling failure logs only redacted `reach_internal` | `cloudflare/control-plane/test/registry.test.ts`; `cloudflare/control-plane/test/managed-reaches.test.ts` revoked cleanup tests | P0 |
| REG-011 | Body and media-type bounds | Any mutating Registry route | Invalid `content-length`, non-JSON body, malformed UTF-8, body stream >16 KB | Send malformed and oversized requests | `400 invalid_request`, `413 request_too_large`, or `415 unsupported_media_type` as appropriate, always with `no-store` and request ID | Must reject both declared oversize and streamed oversize; bodyless methods should not consume bodies | `cloudflare/control-plane/test/registry.test.ts` malformed-body tests; `cloudflare/control-plane/src/http.ts` | P0 |
| REG-012 | Email composition and redaction | OTP email builder and sender | Valid email input plus a simulated send failure | Build OTP mail and force provider failure | Plain-text and HTML bodies are well formed; failures are redacted and do not include address, OTP, or provider response body | Verify request IDs remain safe to expose and error code mapping stays stable | `cloudflare/control-plane/test/registry.test.ts` email tests | P1 |

## Reach compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| RCH-001 | Node Reach read | `GET /v1/nodes/self/reach` | Valid node credential; no reach, then ready reach | Read before provisioning and after provisioning | Returns `{ "reach": null }` before allocation and after full deletion; returns stable `reach` object when ready | Account bearer and foreign node credential return `401`; stale rows must not leak provider IDs | `cloudflare/control-plane/README.md`; `cloudflare/control-plane/test/managed-reaches.test.ts` | P1 |
| RCH-002 | Reach provision happy path | `POST /v1/nodes/self/reach` | Valid node credential; valid Cloudflare config and loopback `HELMRYTH_REACH_ORIGIN` | Provision once, then re-run the same request | First request allocates opaque `r-<32 hex>.<suffix>` hostname, configures tunnel ingress with exact loopback origin plus `http_status:404`, creates proxied CNAME, returns `reach` plus raw `connectorToken`; second request is idempotent and reconciles the same resources | Never persist raw connector token; returned URL must be HTTPS origin only; provider redirects must be rejected without forwarding bearer token | `cloudflare/control-plane/test/managed-reaches.test.ts` happy-path and redirect tests | P0 |
| RCH-003 | Reach lease serialization | `POST /v1/nodes/self/reach` during concurrent requests | Two concurrent provision attempts for same node | Hold one request inside provider step, issue second request, then release first | One request succeeds; the other gets `409 reach_busy` plus `retry-after: 2`; generation lease prevents duplicate resource creation | Verify stale request never rolls back resources after lease takeover; failure is redacted | `cloudflare/control-plane/test/managed-reaches.test.ts` concurrent lease tests | P0 |
| RCH-004 | Reach ambiguous-write adoption | `POST /v1/nodes/self/reach` during Cloudflare timeout/network failure after commit | Simulated create/update DNS or tunnel write that commits but response fails | Force ambiguous create and update paths, then retry | Retry adopts matching stable resources by opaque name and hostname instead of duplicating or deleting them | Conflicting name, record content, record ID, or tunnel identity must fail closed with retained metadata for operator cleanup | `cloudflare/control-plane/test/managed-reaches.test.ts` adoption tests | P0 |
| RCH-005 | Reach delete happy path | `DELETE /v1/nodes/self/reach` | Ready Reach with stored provider IDs | Delete and repeat delete | `204`; DNS is deleted before tunnel; repeat delete remains idempotent; subsequent `GET` returns `{ "reach": null }` when cleanup fully completes | Verify cleanup does not guess when provider-side name or content was repurposed | `cloudflare/control-plane/test/managed-reaches.test.ts` delete retry tests | P0 |
| RCH-006 | Reach partial cleanup and retained state | `DELETE /v1/nodes/self/reach` with provider failure | Ready Reach plus forced DNS or tunnel cleanup error | Delete, inspect retained D1 row, then retry and run scheduled sweep | Immediate delete may return `503 reach_cleanup_pending`; row retains provider IDs and cleanup counters so later retries are safe and idempotent | Backoff should progress 5m, 15m, 60m, 6h, then max 24h; rows older than 24h need explicit operator attention | `cloudflare/control-plane/test/managed-reaches.test.ts` cleanup-pending/backoff tests | P0 |
| RCH-007 | Reach provider identity fence | Cleanup or reconcile against mutated provider resources | Reach row exists but DNS record or tunnel was repurposed to a foreign target/name | Attempt delete or retry cleanup | Worker refuses destructive guesswork, preserves metadata, and surfaces stable redacted error code instead of deleting repurposed assets | Verify both DNS and tunnel identity conflicts are retained for manual remediation | `cloudflare/control-plane/test/managed-reaches.test.ts` repurposed DNS/tunnel tests | P0 |
| RCH-008 | Scheduled cleanup sweep and Cloudflare budget | Worker cron `*/5 * * * *` | Several retained cleanup rows plus fake Cloudflare API | Run scheduled handler repeatedly | Sweep retries only bounded candidate set, stays beneath free-plan external subrequest ceiling, and redacts provider/network failures | Invalid `CLOUDFLARE_API_TOKEN`, all-zero IDs, non-loopback origin, or malformed suffix should fail closed before any provider call | `cloudflare/control-plane/test/managed-reaches.test.ts` sweep/subrequest/config tests; `cloudflare/control-plane/wrangler.jsonc` | P0 |

## Conduit compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| CON-001 | Conduit `/healthz` | `GET /healthz` | Worker running with and without `COMPOSIO_API_KEY` | Probe readiness | Returns `200 {"service":"helmryth-conduit","ready":<bool>}` with no auth required | Caller must not infer enrollment or auth from readiness alone | `cloudflare/composio-broker/src/index.test.ts` health test | P1 |
| CON-002 | Conduit enrollment mode | `POST /v1/nodes` | `HELMRYTH_CONDUIT_ENROLLMENT_MODE` set to `open` and `closed` | Enroll node in each mode | `open` issues `201 {nodeId, token}`; `closed` returns `503` without breaking existing nodes | Returned token must match `^hry_[0-9a-f]{64}$`; DB stores only SHA-256 token hash and stable `hry_node_<uuid-without-dashes>` Composio user ID | `cloudflare/composio-broker/src/index.ts`; `cloudflare/composio-broker/src/index.test.ts` | P0 |
| CON-003 | Enrollment rate limiting | `POST /v1/nodes` with changing callers | `NODE_ENROLLMENT_LIMITER` bound | Hammer enrollment across IP/UA combinations | Legitimate first requests succeed; limiter returns `429 too many enrollment attempts` on abuse | Rate key must hash bounded fingerprint text; do not trust oversized headers or leak raw fingerprint values | `cloudflare/composio-broker/src/index.ts` | P0 |
| CON-004 | Node auth boundary | `GET /v1/self` | Valid conduit node token, malformed token, disabled node | Probe `/v1/self` | Valid token returns `{nodeId}`; invalid or disabled node returns `401 unauthorized` | Account bearer, raw Composio token, or bare 64-hex token must fail | `cloudflare/composio-broker/src/index.ts`; `DRF-002` for desktop drift | P0 |
| CON-005 | MCP proxy | `POST /v1/mcp` | Valid conduit node token; session exists or needs upgrade | Proxy JSON-RPC request and capture response body, `content-type`, and `mcp-session-id` | Conduit reuses or upgrades session, forwards request body unchanged, passes through `mcp-session-id`, and returns provider response body with `no-store` | Reject bodies >2 MB by declared or actual size; enforce upstream timeout; untrusted session URL must fail closed | `cloudflare/composio-broker/src/index.ts`; `cloudflare/composio-broker/src/index.test.ts`; `server/composio.ts` relay tests | P0 |
| CON-006 | Capability catalog cache | `GET /v1/capabilities/catalog` | Valid node token; `COMPOSIO_TOOLKIT_BASE` reachable | Fetch catalog | Successful responses preserve upstream body with `cache-control: private, max-age=600` | Upstream failure returns `502` with bounded public error text, not provider blob | `cloudflare/composio-broker/src/index.ts` | P1 |
| CON-007 | Active capabilities inventory | `GET /v1/capabilities/active` | Valid node token; connected and no-auth toolkits; multiple pages | Fetch active capabilities | Response merges session-selected toolkits with connected-account inventory, preserving aliases and statuses | Pagination loops, denied connected-account inventory, or more than 20 pages must degrade safely or fail with stable error instead of hanging | `cloudflare/composio-broker/src/index.test.ts` active capability tests | P0 |
| CON-008 | Selected capability status | `GET /v1/capabilities?capabilities=...` | Valid node token; chosen slugs including duplicates and over 50 items | Fetch selected statuses | Slugs are lowercased, deduped, and capped to 50; statuses merge session and connected-account views | Upstream toolkit lookup failure returns `502`; malformed query should not crash or scan full marketplace unnecessarily | `cloudflare/composio-broker/src/index.ts`; `cloudflare/composio-broker/src/index.test.ts` | P1 |
| CON-009 | Capability authorization | `POST /v1/capabilities/:slug/authorize` with optional alias body | Valid node token; zero, one, or many prior accounts for a toolkit | Authorize first account with empty body, then second account with alias | Empty body is valid for first account; alias-normalized request creates trusted HTTPS connect link only; max 5 usable accounts per toolkit | Existing accounts require alias; duplicate alias returns `409`; untrusted redirect URL or missing redirect URL becomes `502`; body >2 KB returns `413` | `cloudflare/composio-broker/src/index.test.ts` alias and authorize tests | P0 |
| CON-010 | Disconnect whole capability | `DELETE /v1/capabilities/:slug` | Valid node token; capability selected or absent | Disconnect by slug | Returns `{removed:1}` when selected connected account exists, `{removed:0}` otherwise | Upstream failure must return `502`; no unowned account ID may be deleted | `cloudflare/composio-broker/src/index.ts`; `cloudflare/composio-broker/src/index.test.ts` | P1 |
| CON-011 | Disconnect one owned account | `DELETE /v1/capabilities/:slug/accounts/:id` | Valid node token; owned and unowned account IDs | Delete specific account | Valid owned account returns `{removed:1}`; absent or foreign account returns `{removed:0}` | Invalid account ID returns `400`; account ownership must be proven from fresh inventory before delete | `cloudflare/composio-broker/src/index.test.ts` owned-account delete tests | P0 |

## Desktop and contract-drift compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| DRF-001 | Desktop Registry client vs Worker contract | `electron/registry-client.mjs` methods `me`, `listInstallations`, `ensureInstallation`, `ensureEndpoint`, `deleteEndpoint`, `revokeInstallation` | Current Registry Worker build | Execute each client method against the current Worker contract | Client now uses `/v1/account`, `/v1/nodes`, `/v1/nodes/self`, `/v1/nodes/:id/credentials/rotate`, `/v1/nodes/self/reach`, and `/v1/nodes/:id`; route and payload drift is resolved | Keep regression coverage so old `/v1/me` and `/v1/installations*` paths do not reappear | `electron/registry-client.mjs`, `electron/registry-client.test.mjs` now assert the exact current routes | P0 |
| DRF-002 | Desktop managed Conduit registration vs Worker contract | `electron/managed-composio.mjs` `ensureConduitCredentials` and `managedConduitAccess` | Current Conduit Worker build | Register and health-check through the helper | Helper now uses `GET /v1/self`, `POST /v1/nodes`, and the `hry_<64 hex>` token contract; route and token drift is resolved | Keep regression coverage so bare 64-hex tokens and `/v1/installations` do not reappear | `electron/managed-composio.mjs`, `electron/managed-composio.test.mjs`, `cloudflare/composio-broker/src/index.ts` | P0 |
| DRF-003 | Companion account orchestration error mapping | `electron/companion-account-service.mjs` friendly messages | Current Worker error catalog | Force Registry errors for `node_limit_reached`, `node_exists`, `reach_busy`, `reach_cleanup_pending`, and compare surfaced copy | User-facing copy now maps current `node_*` and `reach_*` codes without referring to the old installation or endpoint names | Keep regression coverage so future worker-code changes cannot silently degrade recovery copy | `electron/companion-account-service.mjs`, `electron/companion-account-service.test.mjs`, Worker codes in `cloudflare/control-plane/src/nodes.ts` and `reaches.ts` | P0 |
| DRF-004 | Managed companion tunnel credential persistence | `electron/managed-companion-tunnel.mjs` plus Registry provision response | Valid provision response with `reach`/connector token after compatibility layer is resolved | Persist access, restart app, and reactivate managed tunnel | Only complete HTTPS origin plus valid connector token are stored; token never appears in argv, env, logs, status, or URL; production trusts only bundled `Resources/cloudflared` | Reject insecure endpoint, short token, relative binary override, foreign-owned runtime directory, and stale token-file cleanup broadening | `electron/managed-companion-tunnel.test.mjs` | P0 |
| DRF-005 | Companion origin gateway | `electron/companion-origin-gateway.mjs` loopback gateway and health probe | Running managed companion sidecar or test socket target | Probe `/api/health`, then proxy normal traffic through loopback gateway | Gateway forwards only to closed-over private UDS/named pipe, strips hop-by-hop headers, and fails closed with `503` when target PID is dead or gateway invalidated | Mid-stream origin close must tear down downstream response instead of hanging; endpoint cleanup must touch only exact allocated socket path | `electron/companion-origin-gateway.test.mjs` | P0 |

## MCP and proxy compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| MCP-001 | CLI MCP server `scripts/mcp-server.ts` | JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; exact tools: `get_system_health`, `list_operators`, `get_operator_messages`, `send_operator_message`, `create_operator`, `update_operator_profile`, `list_crews`, `get_crew_messages`, `send_crew_message`, `create_crew`, `update_crew`, `create_run`, `switch_run`, `rename_run`, `search_messages`, `wait_for_conversation`, `set_operator_model`, `list_available_models`, `interrupt_conversation` | Local server running | Initialize, list tools, call each tool once with valid and invalid payloads | Handshake returns valid MCP identity and all 19 tools; each tool maps to the expected local API route and bounded response shape | `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` are unsupported and must fail explicitly; mutating tools must preserve run/race guards | `scripts/mcp-server.ts`; manual MCP transcript capture | P1 |
| MCP-002 | Computer proxy MCP server | JSON-RPC `initialize`, `tools/list`, and tool calls `screenshot`, `browser_state`, `browser_snapshot`, `browser_click`, `browser_fill`, `wait_for_navigation`, `observation_metrics`, `computer_status`, `computer_request_help`, `click`, `type_text`, `press_key`, `scroll`, `computer_batch`, `computer_exec`, `open_url` | Local computer or box path configured; optional control broker | Call each tool once when free and once while human hold is active | Tools execute or refuse consistently; hold state blocks only `tools/call`; screenshots and browser tools stay within audited payload shapes | Unknown methods return JSON-RPC error; hold refusal text must state no action occurred and instruct fresh screenshot after hand-back | `server/computer-proxy.ts`; `server/computer-proxy.test.ts`; `server/control-client.ts` | P0 |
| MCP-003 | Shared stdio bridge | `server/mcp-bridge.ts` line transport | Child command available; optional gate and optional liveness probe | Run transparent bytes through bridge, then simulate held state and dead transport | Non-`tools/call` frames pass byte-for-byte; only held `tools/call` is refused locally; silence alone never kills, only failed probe after inactivity | Async held check must preserve protocol order; broken hold check fails open; UTF-8 chunk boundaries must not corrupt frames | `server/mcp-bridge.test.ts` | P0 |
| MCP-004 | Local VM MCP entry | `server/container-mcp.ts` argv and env | Valid runtime, container, and `/run/user/1000/...` socket; optional control env | Start entrypoint and send MCP traffic | Invalid runtime or socket exits `2`; valid path delegates to shared bridge and never leaks control token via argv | No liveness watchdog here; failures should come from local runtime fast path rather than WAN assumptions | `server/container-mcp.ts`; `server/container-mcp.test.ts` | P1 |
| MCP-005 | VPS MCP entry | `server/vps-container-mcp.ts` argv, liveness, and env gate | Valid SSH alias and container name; optional control env | Start entrypoint, then wedge SSH transport | Valid path delegates to shared bridge plus liveness probe `docker version --format {{.Server.Version}}`; invalid argv exits `2` | Probe must diagnose transport death, not kill a slow but live tool call; no credentials are stored by the entrypoint | `server/vps-container-mcp.ts`; `server/mcp-bridge.test.ts`; `server/vps-container-mcp.test.ts` | P0 |
| MCP-006 | Connector proxy | JSON-RPC `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; internal routes `POST /api/internal/connectors/mcp` and `POST /api/internal/connectors/request` | Harness server running with `HELMRYTH_COMMS_TOKEN`; optional upstream MCP endpoint | Initialize locally, relay upstream session header, then trigger `COMPOSIO_MANAGE_CONNECTIONS` and `WAIT_FOR_CONNECTIONS` style tool calls | Handshake always succeeds locally; upstream `mcp-session-id` is captured and replayed; connection-manage tool calls become authenticated secure-card requests with slugs and resume key; wait tool returns local guidance | Upstream unavailability must produce JSON-RPC error for non-call methods and tool-shaped error text for tool calls; stdout must not leak upstream auth headers | `server/connector-proxy.test.ts`; `server/connector-proxy.ts`; `server/index.ts` internal routes | P0 |
| MCP-007 | Permission proxy | JSON-RPC tool calls `approve` and `ask_user`; socket messages `{t:"ask"}` and `{t:"answer"}` | Running local permission broker socket | Approve allow, approve deny, ask question, then kill socket mid-wait | Tool results follow CLI contract; allow may return suggested updated permissions; broker death resolves waits as deny instead of hanging | Unknown methods return `-32601`; malformed socket messages must be ignored safely | `server/permission-proxy.ts` | P1 |
| MCP-008 | Agents proxy | JSON-RPC tool calls `list_operators`, `ask_operator`, `delegate_operator`, `check_delegation`, `wait_delegation`, `create_operator`, `request_credential`, `list_cadences`, `propose_cadence`, `propose_cadence_action`; internal routes `GET /api/internal/agents`, `POST /api/internal/ask-bot`, `POST /api/internal/delegate-bot`, `GET /api/internal/delegations/:taskId`, `POST /api/internal/create-bot`, `POST /api/internal/request-credential`, `GET /api/internal/routines`, `POST /api/internal/routine-requests` | Harness server and comms token configured | Exercise each tool once with valid inputs and once with malformed/race inputs | Tool surface matches internal route ownership, preserves user-gated actions for credentials and cadences, and never claims gated change is complete before confirmation | Depth/recursion, invalid schedule shape, max operators per turn, and bad delegation IDs must fail with exact guidance instead of hanging or inventing state | `server/drivers/agents-proxy.ts`; `server/drivers/agents-proxy.test.ts`; `server/index.ts` | P0 |
| MCP-009 | dweb proxy | JSON-RPC tool calls `dweb_status`, `dweb_repo_status`, `dweb_opencode_models`, `dweb_opencode_run`; dweb routes `/ping`, `/api/repo/status`, `/api/opencode/models`, `/api/opencode/run` | Local dweb daemon or stub server | Initialize, list tools, then call each tool | Tool output is bounded text, not raw JSON dump; `dweb_opencode_run` can wait up to 5 minutes and returns output or error text | Bad `command`, bad `model`, daemon errors, or invalid JSON responses become tool errors with sanitized daemon address | `server/drivers/dweb-proxy.ts`; `server/drivers/dweb-proxy.test.ts` | P1 |
| MCP-010 | Phone proxy | JSON-RPC tool calls `status`, `read_screen`, `screenshot`, `list_apps`, `open_app`, `tap_text`, `tap`, `swipe`, `type_text`, `press` | Authorized USB Android device when manual; stub harness for automated cases | Initialize, list tools, then exercise each tool with one valid and one invalid input | Device status is checked first; screen reads and screenshots are bounded; actions validate coordinates, key names, ASCII-only text, and ambiguity before interacting | Unauthorized/missing device, ambiguous app names, oversize or non-ASCII text, and unsupported keys return safe tool errors; no password/OTP entry is automated | `skills/phone-harness/SKILL.md`; `server/drivers/phone-proxy.ts`; `server/drivers/phone-proxy.test.ts` | P0 |

## Operations and deployment compact cases

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| OPS-001 | Registry deployment config | `pnpm registry:check`, `pnpm registry:test`, `pnpm registry:dry-run`, `wrangler.jsonc` validation | Fresh checkout; local `.dev.vars` only for local dev | Run type generation/check/test/dry-run; inspect config for placeholders | Local checks pass; checked-in config remains intentionally local-safe with `.test` names, all-zero account/zone/database IDs, no production route, and secrets required out-of-band | Production deploy must fail closed if placeholders remain; never treat `workers_dev: true` plus `.test` vars as deployable prod config | `package.json`, `cloudflare/control-plane/package.json`, `cloudflare/control-plane/wrangler.jsonc`, README | P0 |
| OPS-002 | Conduit deployment config | `pnpm conduit:check`, `pnpm conduit:test`, `pnpm conduit:dry-run`, `wrangler.jsonc` validation | Fresh checkout | Run type generation/check/test/dry-run; inspect DB ID and rate-limit namespace ownership | Local checks pass; checked-in DB ID remains all zeroes and no production hostname is present | Production deploy must replace namespace IDs and DB ID in owned config, confirm Composio bases, and keep API key only in Wrangler secret store | `package.json`, `cloudflare/composio-broker/package.json`, `cloudflare/composio-broker/wrangler.jsonc`, README | P0 |
| OPS-003 | Cloudflare least-privilege and placeholder proof | Manual operator checklist | Owned Cloudflare account, zone, D1 DB, sender, and API token | Validate account ID, zone ID, D1 ID, sender address, and API token scopes before deploy | Registry token has Tunnel write plus DNS read/write only for selected zone; Reach origin is exact loopback HTTP origin; host suffix belongs to selected zone and cert coverage | All-zero IDs, `.test` sender, or inherited hostnames are automatic release blockers; capture screenshots and `wrangler` config diffs as evidence | Registry and Conduit READMEs; `cloudflare/control-plane/src/config.ts` | P0 |
| OPS-004 | Packaged proxy and binary presence | `scripts/smoke-packaged-server.mjs`, proxy path resolution, bundled `cloudflared` | Built package artifacts | Verify `SPAWNED_PROXIES` paths exist in packaged layout and production cloudflared resolves from `Resources/cloudflared` | Packaged app contains every spawned proxy entry; hosted companion path trusts bundled binary only in production | A misplaced bundle anchor or missing proxy should fail packaging/smoke, not wait until runtime after `/api/health` is green | `server/proxy-paths.ts`; `package.json`; `electron/managed-companion-tunnel.test.mjs` | P0 |
| OPS-005 | Secret rotation and recovery | Manual rotation drill | Existing deployed Registry, Conduit, and one enrolled desktop | Rotate account bearer, node credential, conduit token, and Cloudflare/Composio secrets in isolation | Rotation/re-enrollment preserves least privilege and clear recovery path; stale credentials fail closed without orphaning durable provider resources | Confirm transient outages keep valid identities instead of churning durable grants or spawning duplicate nodes | `cloudflare/control-plane/test/registry.test.ts`; `cloudflare/composio-broker/src/index.test.ts`; `electron/managed-composio.test.mjs`; `electron/registry-client.test.mjs` | P1 |

## Expanded scenarios

### `REG-004` — OTP sign-in preserves enumeration safety and signed-bearer separation

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Registry Worker
- **Surface / route:** `/api/auth/email-otp/send-verification-otp`, `/api/auth/sign-in/email-otp`, `/v1/account`
- **Controls / triggers:** `POST` OTP request, `POST` OTP verify, `GET` account
- **Preconditions and fixtures:** Valid `REGISTRY_DB`, `REGISTRY_EMAIL`, and `HELMRYTH_REGISTRY_AUTH_SECRET`; one known email and one unknown email
- **Steps:**
  1. Request OTP for an unknown email.
  2. Request OTP for a known email.
  3. Verify a valid OTP and capture the `set-auth-token` header plus the raw JSON `token`.
  4. Call `/v1/account` with the signed header token.
  5. Call `/v1/account` with the raw Better Auth body token.
- **Expected visible output:** None; API-only flow.
- **Expected persisted / network output:** OTP row is hashed; account session works only with signed bearer header; responses are `no-store` and include public error codes only.
- **Failure and recovery assertions:** Invalid, expired, and replayed OTPs return canonical errors; 429s stay public-code-only; sign-out revokes future `/v1/account` calls.
- **Accessibility assertions:** Not applicable to API transport.
- **Security and privacy assertions:** Unknown and known emails are indistinguishable at the public API; raw DB token never becomes the accepted session credential.
- **Cleanup / reset:** Delete or isolate created test users in disposable D1 state.
- **Automation mapping:** `cloudflare/control-plane/test/registry.test.ts`, `electron/registry-client.test.mjs`
- **Evidence to retain:** Response headers, sanitized response bodies, D1 verification row snapshot

### `REG-009` — node rotation revokes the old credential without confusing credential classes

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Registry Worker
- **Surface / route:** `/v1/nodes`, `/v1/nodes/:id/credentials/rotate`, `/v1/nodes/self`
- **Controls / triggers:** `POST` node create, `POST` rotate, `GET` node self
- **Preconditions and fixtures:** Signed account bearer and one enrolled node
- **Steps:**
  1. Create a node and capture the initial credential.
  2. Resolve `/v1/nodes/self` with the initial credential.
  3. Rotate credentials as the owning account.
  4. Re-run `/v1/nodes/self` with old and new credentials.
  5. Repeat a rapid second rotate to hit cooldown/conflict behavior.
- **Expected visible output:** None; API-only flow.
- **Expected persisted / network output:** Old credential row is revoked, new credential row is active, `last_rotation_at` is set, and node metadata stays stable.
- **Failure and recovery assertions:** Cooldown returns `credential_rotation_rate_limited`; concurrent rotate returns `credential_rotation_conflict`; account bearer on `/v1/nodes/self` remains unauthorized.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Only owning account can rotate; old credential stops authenticating immediately.
- **Cleanup / reset:** Revoke created node.
- **Automation mapping:** `cloudflare/control-plane/test/registry.test.ts`
- **Evidence to retain:** Rotation response, self-route responses before/after, D1 credential rows

### `RCH-003` — concurrent Reach provisioning serializes through the D1 lease

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Registry Worker
- **Surface / route:** `/v1/nodes/self/reach`
- **Controls / triggers:** Two concurrent `POST` requests
- **Preconditions and fixtures:** Valid node credential; fake Cloudflare API with pause gate
- **Steps:**
  1. Pause the first provision request after resource creation begins.
  2. Issue a second provision request with the same node credential.
  3. Observe the second response before releasing the first.
  4. Release the first request and re-read reach state.
- **Expected visible output:** None.
- **Expected persisted / network output:** Only one tunnel and one DNS record are created; second request returns `409 reach_busy` and `retry-after: 2`.
- **Failure and recovery assertions:** Stale request must not roll back adopted resources after lease takeover; later retry should reconcile the same Reach.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Provider IDs remain server-side only; connector token is returned once to the node caller.
- **Cleanup / reset:** Delete Reach and run cleanup sweep if necessary.
- **Automation mapping:** `cloudflare/control-plane/test/managed-reaches.test.ts`
- **Evidence to retain:** Fake Cloudflare call log, HTTP responses, D1 `node_reaches` snapshots

### `RCH-006` — partial cleanup is retained and retried without destructive guessing

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Registry Worker
- **Surface / route:** `DELETE /v1/nodes/self/reach`, scheduled cleanup
- **Controls / triggers:** Delete followed by cron sweep
- **Preconditions and fixtures:** Ready Reach plus injected DNS or tunnel delete failure
- **Steps:**
  1. Delete a ready Reach and force one provider cleanup step to fail.
  2. Confirm immediate response and retained cleanup state.
  3. Run scheduled cleanup repeatedly through the documented backoff windows.
  4. Repeat with a repurposed DNS record or tunnel.
- **Expected visible output:** None.
- **Expected persisted / network output:** Retained provider IDs, incremented cleanup attempts, and eventually either successful cleanup or a row old enough for manual attention.
- **Failure and recovery assertions:** Response may be `503 reach_cleanup_pending`; repurposed provider resources are never deleted by guesswork.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Provider error blobs and connector tokens stay redacted.
- **Cleanup / reset:** Remove retained fake provider resources in harness fixture.
- **Automation mapping:** `cloudflare/control-plane/test/managed-reaches.test.ts`
- **Evidence to retain:** Cleanup row timeline, fake provider logs, cron run transcript

### `CON-005` — Conduit proxies MCP with session upgrade, header passthrough, and body bounds

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Conduit Worker
- **Surface / route:** `POST /v1/mcp`
- **Controls / triggers:** JSON-RPC request body and optional `mcp-session-id` header
- **Preconditions and fixtures:** Enrolled Conduit node; legacy and multi-account session fixtures; upstream Composio stub
- **Steps:**
  1. Call `/v1/mcp` with a valid node token and no prior session.
  2. Repeat with a legacy session that lacks multi-account echo.
  3. Repeat with `mcp-session-id` set.
  4. Repeat with declared and actual body size over 2 MB.
- **Expected visible output:** None.
- **Expected persisted / network output:** Session is created or upgraded once per node, `last_seen_at` updates, request body is forwarded unchanged, and upstream `mcp-session-id` is mirrored back.
- **Failure and recovery assertions:** Oversize bodies return `413`; invalid upstream session URL becomes service failure; transient session lookup/create errors surface bounded public errors.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Desktop never receives project API key or provider OAuth tokens; only node token is accepted at Conduit boundary.
- **Cleanup / reset:** Disable or delete disposable node.
- **Automation mapping:** `cloudflare/composio-broker/src/index.test.ts`; `server/composio.test.ts`
- **Evidence to retain:** Upstream request log, D1 row updates, response headers

### `CON-009` — multi-account authorize flow enforces alias and trusted-link rules

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** Conduit Worker
- **Surface / route:** `POST /v1/capabilities/:slug/authorize`
- **Controls / triggers:** Authorize with empty body, JSON alias body, duplicate alias body, and oversized body
- **Preconditions and fixtures:** Valid node token; zero, one, and five usable connected accounts for the same toolkit; upstream link stub
- **Steps:**
  1. Authorize first account with empty request body.
  2. Authorize second account with no alias.
  3. Authorize second account with unique alias.
  4. Authorize with duplicate alias.
  5. Authorize with untrusted redirect URL and with missing redirect URL.
- **Expected visible output:** None.
- **Expected persisted / network output:** First-account request succeeds without alias; follow-on authorization requires unique alias; returned link is HTTPS on `composio.dev` or subdomain only.
- **Failure and recovery assertions:** Maximum account cap returns `409`; duplicate alias returns `409`; bad body returns `400` or `413`; untrusted URL returns `502`.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Authorization links are never persisted in Workstream records and no provider token crosses the desktop boundary.
- **Cleanup / reset:** Delete disposable connected accounts.
- **Automation mapping:** `cloudflare/composio-broker/src/index.test.ts`
- **Evidence to retain:** Request/response bodies, alias inventory snapshots

### `DRF-001` — desktop Registry helper stays aligned with the live Worker contract

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg, Registry Worker
- **Surface / route:** `electron/registry-client.mjs` against Registry Worker
- **Controls / triggers:** Hosted sign-in, node adoption, reach enable/disable from desktop shell
- **Preconditions and fixtures:** Current Registry Worker deployed or running locally; desktop build with hosted flow enabled
- **Steps:**
  1. Run the focused desktop client tests.
  2. Verify account lookup uses `/v1/account`.
  3. Verify node lifecycle uses `/v1/nodes`, `/v1/nodes/self`, `/v1/nodes/:id/credentials/rotate`, and `/v1/nodes/:id`.
  4. Verify hosted endpoint lifecycle uses `/v1/nodes/self/reach`.
- **Expected visible output:** None; this is source-level and client-contract verification.
- **Expected persisted / network output:** The helper translates current `account`, `node`, and `reach` payloads without compatibility shims or legacy aliases.
- **Failure and recovery assertions:** Any reappearance of `/v1/me` or `/v1/installations*` is a regression and should fail this suite immediately.
- **Accessibility assertions:** Capture onboarding screens at 390px, 768px, and 1440px if the failure is user-visible.
- **Security and privacy assertions:** No raw account bearer, node credential, or connector token should be shown in UI or logs.
- **Cleanup / reset:** Delete any disposable worker state that was created before failure.
- **Automation mapping:** `electron/registry-client.test.mjs`
- **Evidence to retain:** Focused test report showing the current route set

### `MCP-003` — bridge gating refuses only held tool calls and dead transport only after failed probe

- **Priority:** P0
- **Execution:** Automated — passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** `server/mcp-bridge.ts`
- **Controls / triggers:** JSON-RPC lines, optional held-state callback, optional liveness probe
- **Preconditions and fixtures:** Fake child process, scripted probe results
- **Steps:**
  1. Pass initialize, tools/list, tools/call, and non-JSON lines through bridge with hold off.
  2. Repeat with hold on for a single `tools/call`.
  3. Trigger inactivity windows where first probe succeeds and second probe fails.
  4. Inject traffic while a failed probe is in flight.
- **Expected visible output:** None.
- **Expected persisted / network output:** Non-call lines are forwarded byte-for-byte; held tool call is answered locally with refusal text; inactivity only kills after failed probe and no traffic veto.
- **Failure and recovery assertions:** Broken held-check fails open; UTF-8 split boundaries remain intact; stop is terminal.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Control token remains in env only, never argv.
- **Cleanup / reset:** Stop fake child and watchdog.
- **Automation mapping:** `server/mcp-bridge.test.ts`
- **Evidence to retain:** Forwarded/refused frame log and probe timeline

### `OPS-001` — production placeholder validation fails closed before deploy

- **Priority:** P0
- **Execution:** Manual — executable
- **Platforms:** Registry Worker, Conduit Worker
- **Surface / route:** `wrangler.jsonc`, `pnpm registry:dry-run`, `pnpm conduit:dry-run`
- **Controls / triggers:** Dry-run deployment and config review
- **Preconditions and fixtures:** Fresh checkout, owned production config outside checked-in placeholders
- **Steps:**
  1. Run `pnpm registry:check`, `pnpm registry:test`, `pnpm registry:dry-run`.
  2. Run `pnpm conduit:check`, `pnpm conduit:test`, `pnpm conduit:dry-run`.
  3. Inspect both checked-in Wrangler configs for `.test` hostnames, all-zero IDs, `workers_dev: true`, and required secrets.
  4. Verify production deployment config replaces every placeholder with owned resources before actual deploy.
- **Expected visible output:** Dry-run should succeed locally while clearly remaining non-production due to placeholder config.
- **Expected persisted / network output:** No production deployment is attempted from checked-in placeholder config.
- **Failure and recovery assertions:** Any all-zero account/zone/database ID, placeholder sender, or inherited namespace ID is an automatic release block.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Secrets stay in Wrangler secret store or local `.dev.vars`, never source control.
- **Cleanup / reset:** Remove local `.dev.vars` from disposable environments if created for the test.
- **Automation mapping:** Package scripts in root and Worker package manifests
- **Evidence to retain:** Command transcripts and redacted config diff against owned deployment config
