# Security, Privacy, and Data Migration QA

This document defines the production security/privacy QA plan for Helmryth's local harness, Electron shell, Reach companion, webhook ingress, credential migrations, and release chain. It follows the QA case contract in [docs/qa/TEST-CASE-TEMPLATE.md](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/docs/qa/TEST-CASE-TEMPLATE.md) and the threat model in [SECURITY.md](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/SECURITY.md).

## Trust boundaries under test

- `Electron main ↔ renderer preload bridge`: renderer sees only `window.helmryth`, never raw Node or `ipcRenderer` ([electron/preload.cjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/preload.cjs:1)).
- `Renderer / phone / browser ↔ local harness`: the harness trusts loopback only, rejects non-loopback `Host`, and rejects non-loopback browser `Origin` ([server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:3417)).
- `Phone ↔ Reach companion`: device tokens are required for the network listener, the route surface is allowlisted, and cloud desktop join is separately capability-gated ([companion/src/proxy.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/companion/src/proxy.ts:217), [companion/src/routes.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/companion/src/routes.ts:47)).
- `Electron ↔ OS secret store`: credentials are migrated out of plaintext config and stored in `credentials.bin` through `safeStorage`, with fail-closed behavior when the store cannot be read ([electron/main.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/main.mjs:230), [electron/workspace-credentials.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/workspace-credentials.mjs:18)).
- `External webhook sender ↔ webhook ingress`: only valid capability URLs or bearer secrets are accepted, payloads are size-bounded, and duplicate deliveries are deduplicated ([server/webhook-ingress.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/webhook-ingress.ts:96), [server/webhooks.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/webhooks.ts:138)).
- `Packaged app ↔ release repository / third-party binaries`: update target, codesign, notarization, cloudflared provenance, and CUA SBOM are all release gates ([.github/workflows/release.yml](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/.github/workflows/release.yml:1), [scripts/verify-linux-package.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/scripts/verify-linux-package.mjs:96)).

## Fixtures and prerequisites

- Use an isolated home such as `HELMRYTH_DATA_DIR="$(mktemp -d)"` for destructive migration or webhook tests.
- Keep one packaged desktop build available for macOS or Windows secret-store tests, because development shell runs can intentionally fall back to plaintext config for contributor convenience.
- For webhook tests, create a disposable bot and webhook through the local UI or `POST /api/webhooks`.
- For companion tests, run the Reach sidecar and keep one phone or simulator plus one hostile browser available.
- For release-chain tests, use a non-production draft release repository and disposable secrets; never exercise publish or notarization against production credentials first.

## Evidence collected for this pass

- Automated proof run on August 30, 2026: `pnpm exec vitest run src/lib/analytics.test.ts src/lib/webhook-credentials.test.ts src/lib/companion-pairing.test.ts companion/test/control.test.ts companion/test/devices.test.ts companion/test/routes.test.ts server/redact.test.ts server/webhook-ingress.test.ts scripts/verify-update-target.test.mjs`
- Result: `9` files passed, `147` tests passed.
- Existing but not re-run in this pass: `server/index.test.ts`, `server/webhooks.test.ts`, `server/decision-log.test.ts`, `server/decision-log-wiring.test.ts`, `companion/test/proxy.test.ts`, `electron/managed-companion-tunnel.test.mjs`, `electron/companion-origin-gateway.test.mjs`, `electron/diagnostics.test.mjs`, `scripts/cua-linux-release.test.mjs`, `scripts/release-builder-config.test.mjs`.
- One verification mistake was observed and closed: several Electron and script suites are Vitest suites, not `node --test` suites. They must continue to run under `pnpm exec vitest run ...`.

## Compact control coverage

### Local authn, authz, and boundary controls

| ID | Surface / route | Control / trigger | Threat / preconditions | Action | Expected result | Negative / edge | Evidence | Cleanup | Priority |
|---|---|---|---|---|---|---|---|---|---|
| `SEC-001` | Harness `GET /api/health`, all routes behind host/origin gate | Raw HTTP request with forged `Host` | Attacker can reach `127.0.0.1:8799` from the same machine or a DNS-rebinding page can coerce a browser request | `curl -H 'Host: evil.example' http://127.0.0.1:8799/api/health` and `curl -H 'Host: [::1]' http://127.0.0.1:8799/api/health` | Non-loopback host returns `403 {"error":"forbidden: loopback host required"}`; valid IPv4/IPv6 loopback authorities succeed | Verify malformed authorities like bare `:8799`, `localhost.evil`, and bracket spoofing fail closed | Automated: `server/index.test.ts` loopback authority coverage. Manual: capture `curl` output and `server.log` line if any | None | `P0` |
| `SEC-002` | Harness cross-origin gate before route dispatch | Browser `Origin` header on loopback API | Host is loopback but request originates from a foreign web page | From DevTools or `fetch`, send `POST http://127.0.0.1:8799/api/cli-test` with `Origin: https://evil.example` and JSON body | Response is `403 {"error":"forbidden: cross-origin request"}` before route logic runs | Confirm no CORS preflight response is added that would permit hostile origin reads or writes | Source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:3462). Manual exploit attempt required | None | `P0` |
| `SEC-003` | Harness internal peer routes under `/api/internal/*` | Shared bearer token | Attacker found a local route path but not the boot-scoped internal token | `curl http://127.0.0.1:8799/api/internal/agents?self=<bot>` and retry with wrong `Authorization: Bearer nope` | Missing or bad token returns `401 {"error":"unauthorized"}`; valid token still requires a known sender and returns `403` for unknown `self` | Confirm these routes never return `404`, which would mask missing auth, and never accept cookie/session state | Source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:3470). Manual plus unit coverage in `server/comms.test.ts` and `server/drivers/agents-proxy.test.ts` | None | `P0` |
| `SEC-004` | `POST /api/bots/:botId/secret-cards/:messageId/(provided|resume|dismiss)` | Secret-card resume actions | Attacker or stale UI knows a prior message id or thread id | Attempt `provided`, `resume`, and `dismiss` with wrong `threadId`, after dismiss, and after deleting the underlying credential | Wrong thread or missing card returns `404`; dismissed card returns `409`; resume after credential removal returns `409`; no secret value appears in response or transcript | Re-run after credential save to confirm only configured-state booleans move the flow forward | Source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:6276). Automated: `server/index.test.ts` credential-card flows | Remove test card or reset data dir | `P0` |
| `SEC-005` | `POST/GET /api/bots/:botId/connector-cards/:messageId/*` | Connector authorization cards | Stale UI or cross-thread replay attempts to steal connector resume flow | Use valid card id with wrong `threadId`; call `resume` before status becomes connected; call `dismiss` then retry authorize | Wrong thread returns `404`; premature resume returns `409`; authorize URL is returned only to the exact local card flow and is not persisted in transcript | Confirm failure strings are truncated and contain no OAuth secrets | Source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:6308). Automated: `server/index.test.ts`, `server/composio.test.ts` | Revoke disposable connector auth if completed | `P1` |
| `SEC-006` | Reach loopback control plane `GET /state`, `POST/DELETE /pairing`, `DELETE /devices/:id` | `Host` + exact `Origin` match on control server | Malicious browser page can hit `127.0.0.1:8811` but must not open pairing or revoke devices | Send `POST /pairing` with `Origin: https://evil.example`, `Origin: null`, `Origin: http://127.0.0.1:<other-port>`, and correct same-origin `Origin` | All foreign or opaque origins fail with `403`; only exact control-server origin succeeds; no pairing window opens on failed attempts | Check same-origin browser page still works for `GET` and mutating methods; verify bare non-browser requests without `Origin` remain supported | Automated and re-run: `companion/test/control.test.ts` | Cancel pairing window if one was opened | `P0` |
| `SEC-007` | Reach network listener `:8810` | Browser-origin denial before token parse | Hostile browser on same LAN discovers companion port | Send any request with an `Origin` header, including `http://127.0.0.1:1234` or `https://evil.example`, to `http://<lan-ip>:8810/api/health` | Request fails with `403 {"error":"forbidden: cross-origin request"}` before bearer parsing | Verify this holds even when the origin is loopback and the token is valid; browsers are always denied | Automated: `companion/test/proxy.test.ts`. Manual with `curl -H 'Origin: https://evil.example'` | None | `P0` |
| `SEC-008` | Reach companion route allowlist | Default-deny route surface | Phone has a valid token but tries routes the mobile surface did not explicitly allow | Send token-authenticated requests to `/api/webhooks`, `/api/connectors/<slug> DELETE`, `/api/internal/agents`, `/api/bots%2f..%2fwebhooks` | Unlisted routes fail closed with `403` explained denial or `404 no route`; encoded traversal never matches an allowlist regex | Confirm newly added harness routes are inaccessible from the phone until explicitly allowlisted | Automated: `companion/test/routes.test.ts`, `companion/test/proxy.test.ts` | None | `P0` |
| `SEC-009` | Reach cloud desktop join | Per-device `cloudDesktopAccess` capability | Stolen paired phone token exists but owner never enabled cloud desktop | Pair a new device, call `POST /api/bots/:id/computer/join`, then enable desktop access for that device and retry | Default state denies with `403`; after explicit enable the same route is allowed; revocation removes access immediately | Verify revocation disconnects active SSE or control streams only after durable device removal succeeds | Automated and re-run: `companion/test/control.test.ts`, `companion/test/devices.test.ts`, existing `companion/test/proxy.test.ts` | Revoke test device | `P0` |
| `SEC-010` | Pairing window lifecycle | QR token, six-digit code, replay id | Attacker sees LAN port and tries brute force or replay during route changes | Open pairing, submit wrong code `5` times, retry original code after burn, then pair with a `pairRequestId` and replay same logical request on another route | Wrong guesses decrement attempts and burn the window; expired or burned credentials fail; same `pairRequestId` returns same result until original expiry instead of minting a second device | Confirm new pairing window clears replay state and old `expectedToken` cannot close the new window | Automated and re-run: `companion/test/devices.test.ts`, `companion/test/proxy.test.ts`, `src/lib/companion-pairing.test.ts` | Revoke created devices and close pairing | `P0` |
| `SEC-011` | Browser descriptor `browser-connection.json` and tool bridge | Live loopback descriptor with boot token | Stale descriptor from prior Electron boot or attacker-written file exists in user data | Write descriptors with remote URL, dead `pid`, bad token shape, or path/query credentials, then read browser connection | Only `http://127.0.0.1:<port>` plus live `pid` and 64-hex token decode into a usable browser connection | Confirm stale descriptor after app restart is treated as unavailable, not reused | Automated: `server/browser-connection.test.ts` | Delete test descriptor file | `P1` |
| `SEC-012` | Renderer `saveFile` / native save dialog copy | Path traversal, symlink, and TOCTOU guard | Model-rendered markdown or transcript contains attacker-controlled path | Invoke save on `/etc/passwd`, a `file://` URL outside `~/.helmryth`, a symlink escaping `~/.helmryth`, and a file swapped between validation and open | Only real regular files inside canonical `~/.helmryth` are allowed; outside paths fail with "Only files created by your operators can be saved"; swap races fail closed | Confirm Windows path identity re-check catches replace-on-open and Unix `O_NOFOLLOW` rejects symlinks | Automated: `electron/save-file.node-test.mjs`. Manual on packaged desktop for UI wording | Remove temp files and symlinks | `P0` |
| `SEC-013` | `helmryth://install?url=...` deep link | Package URL allowlist | User opens a crafted deep link from browser or shell | Test URLs using `http`, credentials, port, non-GitHub hosts, or non-`.md`/`.json` paths | Only HTTPS on `github.com`, `www.github.com`, or `raw.githubusercontent.com` with `.md` or `.json` path is accepted; all others resolve to no action | Confirm command-line parsing and `open-url` event behave identically | Automated: `electron/package-link.node-test.mjs`; source: [electron/package-link.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/package-link.mjs:1) | None | `P1` |
| `SEC-014` | `POST /api/cli-test` | Local exec probe | Attacker abuses loopback UI to run arbitrary local binary or leak inherited env | Send non-JSON body, empty path, path containing newline, or wrapper binary that prints env | Non-JSON returns `415`; invalid path returns `400`; probe runs `<cli> --version` only; secret-bearing workspace env vars are not inherited | Confirm logs and UI show only probe result, not any secret env values | Automated: `server/index.test.ts`; source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:6017) | Remove disposable probe binary | `P0` |

### Secrets, privacy, persistence, and migration controls

| ID | Surface / route | Control / trigger | Threat / preconditions | Action | Expected result | Negative / edge | Evidence | Cleanup | Priority |
|---|---|---|---|---|---|---|---|---|---|
| `SEC-015` | Boot migration from `config.json` to `credentials.bin` | Packaged desktop startup with legacy plaintext config | User upgrades from a build that persisted plaintext keys | Seed `config.json` with plaintext `xai.key`, `box.token`, `tts.key`, `imageGen.key`, `opencodeGo.apiKey`, and Composio key; launch packaged app | Secrets are copied into encrypted store first, plaintext fields are deleted from config, and app behavior remains configured | If encrypted store write fails, plaintext must remain so the next launch can retry; no key may be lost mid-migration | Source: [electron/main.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/main.mjs:264), [electron/workspace-credentials.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/workspace-credentials.mjs:18). Automated: `electron/secure-credentials.test.mjs`, `electron/workspace-credentials.test.mjs` | Delete isolated data dir | `P0` |
| `SEC-016` | Secure credential read path | Unreadable OS key store | Keychain or OS credential store is temporarily unavailable or corrupted | Simulate unreadable `credentials.bin` or unavailable `safeStorage`, then open Connections and Reach setup | UI reports store unavailable or unreadable state; app never interprets unreadable store as "no credentials"; writes are refused for the launch | Confirm no auto-registration or connector reset happens on unreadable state | Automated: `server/composio-availability.test.ts`, `electron/secure-credential-state.test.mjs`; source: [electron/secure-credentials.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/secure-credentials.mjs:1) | Restore credential store fixture | `P0` |
| `SEC-017` | `PUT /api/config?secretStorage=external` and runtime env sync | Tombstone merge and in-memory secret refresh | Packaged app saves new secret to encrypted store while old plaintext remains in config | Save new credentials with `secretStorage=external`, inspect persisted `config.json`, then issue provider-backed request without restart | Config writes empty tombstones instead of plaintext; old plaintext is not resurrected by merge; running server uses new secret immediately via env sync | Clearing a secret must delete env override instead of leaving stale value active | Source: [server/index.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/index.ts:6142), [server/config.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/config.ts:234) | Remove temp config and keys | `P0` |
| `SEC-018` | Webhook create/list/rotate/delete | One-time secret display and write-only persistence | User creates an internet-capable trigger and later rotates it | Create webhook, list webhooks, rotate secret, and list again | Creation and rotation responses include the one-time credential; list/read paths never echo the secret; rotated URL invalidates old URL | After delete, webhook credentials stored in local app cache should be removable without blocking deletion | Automated: `server/index.test.ts`, `server/webhooks.test.ts`, re-run `src/lib/webhook-credentials.test.ts` | Delete test webhook and remove cached credential | `P0` |
| `SEC-019` | Dedicated webhook ingress `/hooks/:endpointId(/:secret)?` | Capability URL auth and bounded parsing | Internet sender posts malformed, oversized, or wrong-secret payloads | Send wrong secret, 257 KB body, invalid JSON with `application/json`, URL-encoded body, and valid JSON with delivery id | Wrong secret returns `401`; oversized body returns `413`; invalid JSON returns `400`; valid payload returns `202`; rejection metadata records only safe summary fields | Confirm parsing happens only after auth and no raw secret is written into rejection logs | Automated and re-run: `server/webhook-ingress.test.ts`; source: [server/webhook-ingress.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/webhook-ingress.ts:96) | Remove ingress fixture files | `P0` |
| `SEC-020` | Webhook delivery receipts and send idempotency | Replay, duplicate delivery, and request coalescing | Sender retries because prior response was lost or duplicated by provider | Deliver same webhook with same `Idempotency-Key` twice; submit same chat `sendId` concurrently with same and different payloads | Duplicate webhook returns original `runId` with `duplicate: true`; same `sendId` coalesces only identical payloads; mismatched payload gets `409` conflict | Confirm dedupe persists across restart and does not suppress distinct payloads that reused the key incorrectly | Automated: `server/index.test.ts`, `server/webhooks.test.ts`, `server/send-idempotency.test.ts` | Remove webhook receipts and temp messages | `P0` |
| `SEC-021` | Diagnostics export | Redaction and privacy-safe summary | User exports a bundle that may later be pasted into a public issue | Populate logs with fake API keys, bearer tokens, PEM block, env assignments, config names, and URLs with credentials; export diagnostics | Report contains only boolean/number config summary values; known secret patterns are masked; private keys and bearer tokens are redacted | Confirm strings, arrays, account aliases, paths, and raw credentials do not survive flattening | Automated: `electron/diagnostics.test.mjs`, `server/redact.test.ts`; re-run `server/redact.test.ts` | Delete exported diagnostics file | `P0` |
| `SEC-022` | Decision log `/api/decisions` and on-disk `decisions.ndjson` | Redacted audit trail with bounded reads | Approval summaries can contain commands, tokens, or URLs | Trigger auto-approved and carded decisions with credential-shaped summaries; read `/api/decisions?limit=1` and malformed limits | Decision rows are written `0600`, redacted, and read newest-last; invalid limits return `400` | Confirm log rotation preserves recent history and malformed NDJSON fragments do not crash reads | Automated: `server/decision-log.test.ts`, `server/decision-log-wiring.test.ts` | Remove temp decision log dir | `P1` |
| `SEC-023` | Browser localStorage caches | Local-only persistence without cross-product bleed | Browser storage contains predecessor keys covered by the analytics and webhook migration tests, or malformed JSON | Seed the exact legacy fixtures defined by `src/lib/webhook-credentials.test.ts` and `src/lib/analytics.test.ts`, plus malformed connected-capability cache values; load Helmryth UI | Helmryth copies only the allowed read-once data, then deletes or ignores predecessor keys; malformed records are dropped without crashing; no credentials enter the connected-capability cache | Confirm new writes use Helmryth-only keys and do not overwrite predecessor product state beyond one-time migration cleanup | Re-run `src/lib/webhook-credentials.test.ts`, `src/lib/analytics.test.ts`, and `src/lib/connected-apps-cache.test.ts` | Clear browser storage | `P1` |
| `SEC-024` | Product telemetry | Explicit opt-in and HTTPS-only sink | Build contains telemetry runtime values or inherited legacy storage | Start with no consent, legacy opt-out, legacy opt-in-like state, invalid HTTP host, and valid HTTPS host after explicit opt-in | Telemetry stays off by default; legacy refusal remains refusal; legacy enablement does not become Helmryth consent; invalid non-HTTPS host disables telemetry; `identifyEmail` remains no-op | Confirm autocapture and pageview remain disabled and no personal identifier is sent | Automated and re-run: `src/lib/analytics.test.ts` | Clear localStorage and reset test globals | `P0` |
| `SEC-025` | Browser observation and model-facing URL state | URL redaction to tools, logs, and screenshots | Browser target contains query secrets or embedded basic-auth credentials | Feed URLs like `https://user:pass@example.com/app?token=abc#frag` into observation parsing and browser target listing | Internal comparison URL keeps query for equality checks but strips credentials; model-safe URL strips credentials, query, and fragment; overlong or non-HTTP(S) URLs are rejected | Confirm no raw credentialed URL reaches logs, model prompts, or SSE payloads | Automated: `server/computer-observation.test.ts`; source: [server/computer-observation.ts](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/server/computer-observation.ts:66) | None | `P1` |
| `SEC-026` | Managed companion connector runtime | Token-file secrecy and endpoint normalization | Hosted connector token exists in secure store and cloudflared must be launched | Exercise start with invalid endpoint, invalid token, wrong token-file perms, stale token files, and connector stop | Only HTTPS origin endpoints and bounded token shapes are accepted; token file is private (`0600`), stale token cleanup touches only safe dead-owner files, and stop path invalidates gateway before releasing port `8812` | Confirm token never appears in argv, env, status payloads, or logs | Automated: `electron/managed-companion-tunnel.test.mjs`, `electron/companion-origin-gateway.test.mjs`; source: [electron/managed-companion-tunnel.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/electron/managed-companion-tunnel.mjs:1) | Remove runtime temp directory | `P0` |

### CI, release, and supply-chain controls

| ID | Surface / route | Control / trigger | Threat / preconditions | Action | Expected result | Negative / edge | Evidence | Cleanup | Priority |
|---|---|---|---|---|---|---|---|---|---|
| `SEC-027` | Temporary release Electron Builder config | Release-target isolation | Maintainer packages a build with wrong repository target or local `publish` stanza | Run `pnpm release:config:check` with valid and invalid `HELMRYTH_RELEASE_REPO`; inspect generated config file perms and cleanup | Generated config injects `publish` only in the temp file, keeps base config publish-free, writes temp file `0600`, and deletes temp directory after use | Invalid `owner/repo` or preexisting local `publish` field fails before packaging | Automated and re-run: `scripts/verify-update-target.test.mjs`, existing `scripts/release-builder-config.test.mjs` | Remove temp config dir if retained for inspection | `P1` |
| `SEC-028` | Linux package verifier and CUA provenance | SBOM, hash, license, containment, and mode checks | Third-party binary or notice bundle drifts from reviewed artifact set | Run `node scripts/verify-linux-package.mjs` against a packaged Ubuntu build and against a tampered release tree | Verifier rejects wrong hashes, wrong permissions, symlink escapes, missing notices, missing SBOM refs, wrong component counts, or unexpected cloudflared version | Confirm verifier catches changes to `cloudflared`, `cua-driver`, `cua-cursor-theme`, and any file outside expected directories | Automated: `scripts/cua-linux-release.test.mjs`, `scripts/package-release.test.mjs`; source: [scripts/verify-linux-package.mjs](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/scripts/verify-linux-package.mjs:96) | Delete tampered release tree | `P0` |
| `SEC-029` | GitHub Actions CI and packaging workflows | Least privilege and pinned dependencies | CI runner compromise or action supply-chain swap | Review `.github/workflows/*.yml` for top-level permissions, `persist-credentials`, checkout SHAs, and artifact-only publish rules | `contents: read` is the default, actions are SHA-pinned, packaging jobs disable persisted credentials where cross-repo writes are not needed, and artifact workflows never require release PAT | Verify any new workflow preserves the same permission floor and does not inherit broader defaults | Manual review with source references: [.github/workflows/ci.yml](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/.github/workflows/ci.yml:1), [.github/workflows/package-linux.yml](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/.github/workflows/package-linux.yml:1), [.github/workflows/package-win.yml](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/.github/workflows/package-win.yml:1) | None | `P1` |
| `SEC-030` | Full release workflow | Signature, notarization, feed integrity, and publish gate | Broken signature, stale blockmap, wrong update feed, or partial release assembly | Run the release lane against a draft repo; verify codesign before notarization, notarization accepted, stapling precedes hash regeneration, update target matches release repo, and publish remains draft when `publish=false` | Workflow fails before publish on any signature/feed mismatch; published draft contains all artifacts from one pinned commit; stable download links and feed hashes match post-staple bytes | External blockers are expected for Apple certs, notary API, and GitHub PAT; absence of those secrets must fail loudly before packaging | Existing workflow gates in [.github/workflows/release.yml](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/.github/workflows/release.yml:1) and operator guide in [docs/releasing.md](/Users/divyamtalwar/Downloads/GrokBot/Helmryth/docs/releasing.md:1) | Delete draft release and revoke temporary secrets if used | `P0` |

## Expanded exploit-driven scenarios

### `SEC-001` — Harness rejects DNS rebinding and hostile browser origins before route logic

- **Priority:** `P0`
- **Execution:** `Manual — executable`
- **Platforms:** browser development shell, packaged desktop, macOS, Windows, Ubuntu/Xorg
- **Surface / route:** all harness routes behind the pre-route loopback gate, especially `GET /api/health` and `POST /api/cli-test`
- **Controls / triggers:** raw `curl`, browser `fetch`, DevTools console
- **Preconditions and fixtures:** local harness running on `127.0.0.1:8799`; one hostile page or browser console capable of setting a foreign `Origin`
- **Steps:**
  1. Run `curl -i -H 'Host: evil.example' http://127.0.0.1:8799/api/health`.
  2. Run `curl -i -H 'Host: localhost:8799' http://127.0.0.1:8799/api/health`.
  3. From a foreign-origin browser context, send `fetch('http://127.0.0.1:8799/api/cli-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cli: '/bin/echo' }) })`.
  4. Repeat step 3 from the app's own loopback origin.
- **Expected visible output:** hostile host request returns `403`; valid loopback host returns normal health JSON; hostile browser-origin request returns `403` instead of a CORS response; same-origin loopback UI can continue using the API.
- **Expected persisted / network output:** no config writes, no spawned CLI process, no decision-log row, and no state mutation for the blocked requests.
- **Failure and recovery assertions:** any blocked request must fail before downstream route-specific validation; if route-specific errors appear first, the pre-route boundary regressed.
- **Accessibility assertions:** none; this is transport-layer enforcement.
- **Security and privacy assertions:** hostile pages cannot use the loopback API for CSRF or DNS rebinding; failure mode is explicit denial, not fallback behavior.
- **Cleanup / reset:** none.
- **Automation mapping:** `server/index.test.ts` covers valid and invalid loopback authority forms.
- **Evidence to retain:** `curl -i` transcripts for both hostile and valid requests, plus browser Network panel screenshot showing `403` on the hostile origin.

### `SEC-006` — Reach control plane only trusts the page it serves

- **Priority:** `P0`
- **Execution:** `Automated — passing` plus `Manual — executable`
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Reach control server `POST /pairing`, `DELETE /pairing`, `DELETE /devices/:id`, `GET /state`
- **Controls / triggers:** browser page served by the control server, hostile browser origin, direct `curl`
- **Preconditions and fixtures:** Reach companion running; no pairing open at start; one paired disposable device exists for revoke testing
- **Steps:**
  1. Open the real control page from `http://127.0.0.1:8811/` and click `Start pairing`.
  2. Cancel pairing and confirm the page returns to no-open-window state.
  3. From a different loopback port or a `file://`/opaque origin, send `POST http://127.0.0.1:8811/pairing`.
  4. Send `DELETE http://127.0.0.1:8811/devices/<deviceId>` from a foreign origin.
- **Expected visible output:** only the real control page can open or cancel pairing; foreign origins see `403`; the device list remains unchanged on failed revocation.
- **Expected persisted / network output:** no new pairing token is created on denied requests; `devices.json` is unchanged after denied revocation.
- **Failure and recovery assertions:** if a denied request still opens a pairing window, the control plane becomes browser-CSRF vulnerable and the release must stop.
- **Accessibility assertions:** control-page buttons must remain keyboard reachable on the legitimate same-origin page.
- **Security and privacy assertions:** exact origin matching prevents another local web app from using loopback reachability as an authorization bypass.
- **Cleanup / reset:** close the pairing window and revoke any disposable device created during the run.
- **Automation mapping:** `companion/test/control.test.ts` passed in this review run.
- **Evidence to retain:** test log, browser Network panel showing `403`, and `GET /state` response before and after hostile attempts.

### `SEC-010` — Pairing credentials burn correctly and replay only within the single logical pairing request

- **Priority:** `P0`
- **Execution:** `Automated — passing` plus `Manual — executable`
- **Platforms:** iOS, Android, macOS, Windows, Ubuntu/Xorg
- **Surface / route:** `POST /pairing`, `POST /api/pair`, `DELETE /pairing?expectedToken=...`
- **Controls / triggers:** control-page Start Pairing button, phone pairing request, route failover between hosted/LAN addresses
- **Preconditions and fixtures:** Reach running, fresh pairing window, phone or simulator that can retry with stable `pairRequestId`
- **Steps:**
  1. Open a pairing window and note the code and QR token.
  2. Submit an incorrect credential five times through `POST /api/pair`.
  3. Retry the original correct credential after the fifth failure.
  4. Open a new pairing window, redeem it once with a `pairRequestId`, then replay the same logical request on a fallback address before the original expiry.
  5. Open a third pairing window and try closing it with the second window's `expectedToken`.
- **Expected visible output:** the sixth wrong guess ends the window; the original credential no longer works; replay with the same request id returns the same device token instead of pairing a second device; stale `expectedToken` cannot close a newer window.
- **Expected persisted / network output:** only one device record is written for a successful replayed pairing; `devices.json` stores only `tokenHash`, never raw token.
- **Failure and recovery assertions:** if replay creates two devices or stale `expectedToken` closes a newer window, route-failover and race safety regressed.
- **Accessibility assertions:** pairing page countdown remains readable while the window is open.
- **Security and privacy assertions:** short code cannot be brute-forced beyond its capped attempt budget; one-time high-entropy QR token is not reusable after window close.
- **Cleanup / reset:** revoke paired test devices and close the active window.
- **Automation mapping:** `companion/test/devices.test.ts`, `companion/test/proxy.test.ts`, `src/lib/companion-pairing.test.ts`; the latter passed in this review run.
- **Evidence to retain:** `devices.json` excerpt showing only `tokenHash`, request/response capture of replayed pairing, and pairing page screenshots before and after burn.

### `SEC-012` — Save-file flow refuses traversal, symlinks, and mid-open file swaps

- **Priority:** `P0`
- **Execution:** `Manual — executable` plus `Automated — existing`
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** `window.helmryth.saveFile` bridge and native save dialog
- **Controls / triggers:** file-save action from transcript bubble or dev-console invocation
- **Preconditions and fixtures:** create files under `~/.helmryth`, a symlink to `/etc/hosts` or another external file, and a second file for swap-race testing
- **Steps:**
  1. Attempt to save an absolute path outside `~/.helmryth`.
  2. Attempt to save a `file://` URL pointing outside `~/.helmryth`.
  3. Attempt to save a symlink inside `~/.helmryth` whose target is outside the root.
  4. On Windows, replace the file between the initial stat and open if the test harness supports it.
  5. Attempt to save a real operator-created file inside `~/.helmryth`.
- **Expected visible output:** outside paths and symlinks are rejected with explicit safety text; legitimate in-root files reach the save dialog and copy successfully.
- **Expected persisted / network output:** no out-of-root read occurs and no copy is made for denied paths.
- **Failure and recovery assertions:** a path that resolves outside the canonical root or changes identity mid-open must stop the flow instead of copying stale or foreign bytes.
- **Accessibility assertions:** dialog cancel path must return cleanly with no duplicate error wrapper text.
- **Security and privacy assertions:** model-rendered markdown cannot trick the desktop shell into reading arbitrary local files.
- **Cleanup / reset:** remove symlink, temporary files, and any copied outputs.
- **Automation mapping:** `electron/save-file.node-test.mjs`.
- **Evidence to retain:** screenshots of the user-facing error text and filesystem listing proving no denied copy was written.

### `SEC-015` — Packaged upgrade migrates plaintext secrets without data loss or resurrection

- **Priority:** `P0`
- **Execution:** `Manual — executable`
- **Platforms:** macOS packaged app, Windows packaged app
- **Surface / route:** boot-time credential migration and subsequent `/api/config` status read
- **Controls / triggers:** first launch of packaged app against legacy `config.json`
- **Preconditions and fixtures:** isolated `HELMRYTH_DATA_DIR`; legacy `config.json` containing plaintext workspace secrets and old Composio fields
- **Steps:**
  1. Write legacy plaintext secrets into `config.json`.
  2. Launch packaged Helmryth and wait for the harness to answer `GET /api/config`.
  3. Inspect `config.json` after startup.
  4. Save one updated credential through the packaged UI.
  5. Relaunch the app and confirm the updated credential remains configured without plaintext reappearing.
- **Expected visible output:** configuration UI shows providers as configured, not lost; no raw secret is displayed.
- **Expected persisted / network output:** plaintext fields are deleted or tombstoned in `config.json`; `credentials.bin` is present; the updated provider works without relaunch after a save.
- **Failure and recovery assertions:** if the key store is unavailable, startup must refuse migration and leave plaintext intact rather than deleting the only copy.
- **Accessibility assertions:** settings save flow remains usable after migration.
- **Security and privacy assertions:** old secrets are removed from plaintext at rest and are not accidentally re-merged from stale config content.
- **Cleanup / reset:** delete isolated `HELMRYTH_DATA_DIR`.
- **Automation mapping:** existing Electron credential tests plus source review in `electron/main.mjs`.
- **Evidence to retain:** before/after sanitized `config.json`, filesystem proof of `credentials.bin`, and UI screenshot of configured-only status.

### `SEC-018` — Webhook capability URLs remain write-only and rotation invalidates prior secrets

- **Priority:** `P0`
- **Execution:** `Automated — existing` plus `Manual — executable`
- **Platforms:** browser development shell, packaged desktop, Registry Worker optional
- **Surface / route:** `POST /api/webhooks`, `GET /api/webhooks`, `POST /api/webhooks/:id/rotate`, ingress `POST /hooks/:endpointId` with `Authorization: Bearer`, plus explicit legacy compatibility path `POST /hooks/:endpointId/:secret`
- **Controls / triggers:** Webhooks panel buttons or direct API calls
- **Preconditions and fixtures:** one disposable bot, fresh isolated webhook store
- **Steps:**
  1. Create a webhook and record the returned `credential.endpointUrl`, one-time `credential.secret`, and generated `Idempotency-Key`.
  2. Fetch `GET /api/webhooks` and confirm the secret is absent.
  3. Deliver one authenticated event with `Idempotency-Key: build-42`.
  4. Rotate the webhook and deliver the same event to the old URL.
  5. Deliver the event to the new URL.
- **Expected visible output:** create and rotate responses expose the endpoint plus one-time secret once; list views never expose either secret-bearing URL or plaintext secret; replaying the old Bearer secret returns `401` after rotation; the new Bearer secret succeeds.
- **Expected persisted / network output:** webhook attempt log records `accepted`, `duplicate`, and later `rejected` outcomes; the detached run retains `triggerSource: webhook`.
- **Failure and recovery assertions:** if list APIs ever echo the secret or old URL remains valid after rotation, the webhook surface is compromised.
- **Accessibility assertions:** Webhooks panel should surface rotation success and failure states without requiring raw URL inspection.
- **Security and privacy assertions:** one-time secret handling prevents later transcript or settings reads from recovering a secret-bearing capability URL.
- **Cleanup / reset:** delete the webhook and clear cached local webhook credentials.
- **Automation mapping:** `server/index.test.ts`, `server/webhooks.test.ts`, re-run `server/webhook-ingress.test.ts`.
- **Evidence to retain:** sanitized API responses for create, list, rotate, old-secret `401`, and new-secret `202`.

### `SEC-021` — Diagnostics export stays publishable even if raw logs contain credentials

- **Priority:** `P0`
- **Execution:** `Automated — existing` plus `Manual — executable`
- **Platforms:** packaged desktop
- **Surface / route:** `window.helmryth.exportDiagnostics`, local diagnostics file output
- **Controls / triggers:** Diagnostics export button
- **Preconditions and fixtures:** inject fake secrets into `server.log` and runtime status where possible; include API keys, bearer tokens, PEM content, and strings that look like env assignments
- **Steps:**
  1. Start the app with synthetic secret-shaped environment variables and log lines.
  2. Export diagnostics.
  3. Inspect the generated file for raw secret values, personal identifiers, paths, aliases, and query-bearing URLs.
  4. Compare config summary section against `GET /api/config`.
- **Expected visible output:** export succeeds and points to the saved file path; no raw secret is visible in the UI or file.
- **Expected persisted / network output:** diagnostics file contains only allowed app facts, boolean/number config summary values, and masked log content.
- **Failure and recovery assertions:** if any raw credential escapes redaction, diagnostics export must be treated as release-blocking because it is intended for public issue reporting.
- **Accessibility assertions:** save dialog cancel path returns `null` without throwing noisy wrapper text.
- **Security and privacy assertions:** even future collector mistakes remain masked by the final redaction pass.
- **Cleanup / reset:** delete the exported diagnostics file and synthetic logs.
- **Automation mapping:** `electron/diagnostics.test.mjs`, re-run `server/redact.test.ts`.
- **Evidence to retain:** redacted diagnostics file excerpt and comparison note showing missing raw secrets.

### `SEC-030` — Release lane blocks stale, unsigned, or wrongly targeted update artifacts

- **Priority:** `P0`
- **Execution:** `Blocked — external prerequisite`
- **Platforms:** GitHub Actions, macOS runner, Windows runner, Ubuntu 24.04 runner
- **Surface / route:** `.github/workflows/release.yml`, generated artifacts, release repository draft
- **Controls / triggers:** GitHub Actions `Release` workflow dispatch
- **Preconditions and fixtures:** disposable draft release repository, non-production `HELMRYTH_RELEASES_PAT`, Apple signing and notarization secrets, bumped version on a pinned commit
- **Steps:**
  1. Run the `Release` workflow with `publish=false`.
  2. Verify prepare job pins a single commit and refuses missing release-repo configuration.
  3. Inspect macOS gates for codesign verification before notarization and post-staple blockmap/feed regeneration.
  4. Inspect Windows and Linux jobs for explicit `app-update.yml` target verification and packaged-server smoke.
  5. Confirm a draft release, not a published release, is created when `publish=false`.
  6. Download one artifact back from the draft repo and compare its hash to the generated feed or checksum file.
- **Expected visible output:** workflow remains green only when every artifact originates from the pinned commit, points at the configured release repo, and passes signature/provenance gates.
- **Expected persisted / network output:** draft release contains the full cross-platform artifact set; no partial publish occurs; stable downloads map to the same bytes as the verified artifacts.
- **Failure and recovery assertions:** missing secrets, wrong update target, stale blockmap, or failed notarization must stop the lane before publish.
- **Accessibility assertions:** none.
- **Security and privacy assertions:** the release chain proves provenance and prevents silently shipping artifacts that auto-update from the wrong repository or unsigned bytes.
- **Cleanup / reset:** delete the draft release and revoke any temporary PAT or Apple credentials used for rehearsal.
- **Automation mapping:** workflow gates in `release.yml`, `scripts/verify-update-target.mjs`, `scripts/verify-linux-package.mjs`.
- **Evidence to retain:** Actions run URL, draft release URL, `app-update.yml` verification output, notarization acceptance logs, and downloaded artifact hash comparison.

## Coverage summary

- Total cases: `30`
- Expanded high-risk scenarios: `8`
- Execution mix:
  - `Automated — passing in this review run`: `9` source-backed suites, `147` tests
  - `Automated — existing but not re-run in this review pass`: `11` additional suites
  - `Manual — executable`: `17` cases
  - `Blocked — external prerequisite`: `1` case (`SEC-030`)
- Risk coverage:
  - Trust boundaries and authz: `14` cases
  - Secret handling, privacy, and migration: `12` cases
  - CI, release, and supply chain: `4` cases
- Release blockers if any case fails: `SEC-001`, `SEC-002`, `SEC-003`, `SEC-004`, `SEC-006`, `SEC-008`, `SEC-009`, `SEC-010`, `SEC-012`, `SEC-014`, `SEC-015`, `SEC-016`, `SEC-017`, `SEC-018`, `SEC-019`, `SEC-020`, `SEC-021`, `SEC-026`, `SEC-028`, `SEC-030`
