# Helmryth production QA master plan

This directory is the canonical test specification for Helmryth 0.1.0. It covers the desktop renderer, local harness, Electron shell, Workbenches, voice lines, Helmryth Mobile, Android control, iOS, Registry, Conduit, MCP, security boundaries, packaging, and release delivery.

The plan distinguishes what can be proven automatically in this repository from what requires a signed package, real provider account, physical device, operating-system permission, cloud binding, or owner-controlled release destination. A blocked external case is not silently treated as passed.

## Definition of done

A release candidate is eligible for sign-off only when all of the following are true:

1. Every discovered screen, route, control, IPC channel, cloud endpoint, workflow, and package command maps to at least one stable test ID.
2. Every P0 and P1 case is either passing with retained evidence or explicitly blocked by a named external prerequisite and accepted by the release owner.
3. Automated suites pass from a clean dependency install, and every rerun caused by a flaky infrastructure failure is recorded rather than hidden.
4. No active product route or control lacks keyboard, focus, accessible-name/state, error, loading, empty, success, and responsive assertions where those states apply.
5. Consequential actions prove Gate wording, scope, denial, cancellation, persistence, audit trail, and fail-closed behavior.
6. Secrets, tokens, workstream content, file paths, and provider credentials prove redaction and least-privilege boundaries.
7. Packaging proves product identity, artifact names, architecture, update target, signatures when provisioned, checksums, clean install, upgrade, uninstall, and rollback.
8. Public documentation, help copy, accessible names, diagnostics, notifications, logs, and release metadata use the Helmryth vocabulary.
9. The execution report names the exact source revision or archive hash, environment, commands, timestamps, counts, failures, reruns, screenshots, traces, and remaining risk.

## Test case contract

All domain documents follow [TEST-CASE-TEMPLATE.md](TEST-CASE-TEMPLATE.md). Required fields include prerequisites, exact actions, visible and persisted outputs, negative and race cases, accessibility, security/privacy, cleanup, automation mapping, evidence, priority, platform, and execution status.

## Coverage map

| Document | Primary ownership | Required surface |
|---|---|---|
| [01 Desktop shell, onboarding, and roster](01-desktop-shell-onboarding-roster.md) | Renderer shell | Launch, onboarding, roster, search, create/import, archive, density, drawer, update entrypoints |
| [02 Workstreams, crews, runs, and Gates](02-workstreams-crews-runs-gates.md) | Core work UI | Workstreams, composer, messages, attachments, replies, reactions, branching, queueing, runs, crews, Gates |
| [03 System, settings, engines, and identity](03-system-settings-engines-identity.md) | Configuration UI | System navigation, engines, models, operator profile, sigils, voice, keys, telemetry, diagnostics |
| [04 Operations, Cadences, Webhooks, Capabilities, Methods, and Trace](04-operations-cadences-webhooks-capabilities-methods-trace.md) | Operations UI | Operations map, Cadences, Webhooks, Capabilities, accounts, crew packages, Methods, Trace |
| [05 Workbenches](05-workbenches-browser-host-isolated-remote.md) | Execution surfaces | Browser, Host, Isolated, Remote, Box, VPS, split Workbench, leases, viewers, permissions |
| [06 Voice, Mobile, Relay, Android, and iOS](06-voice-mobile-relay-android-ios.md) | Companion experience | Voice lines, spoken Gates, Relay, pairing, Android control, iOS app/widgets/live activity |
| [07 Backend HTTP, SSE, and Webhook API](07-backend-http-sse-webhook-api.md) | Local harness | Every HTTP/SSE/webhook/internal route, schema, status, event, persistence, failure, race, replay |
| [08 Registry, Conduit, and MCP](08-cloud-registry-conduit-mcp.md) | Cloud/integrations | Registry, Reach, Conduit, capability broker, MCP servers/proxies/tools, Cloudflare deployment checks |
| [09 Security, privacy, and data migrations](09-security-privacy-data-migrations.md) | Trust boundaries | Authn/authz, secrets, redaction, paths, injection, telemetry, storage migration, provenance, supply chain |
| [10 Electron, packaging, CI, and release](10-electron-packaging-ci-release.md) | Delivery | Electron lifecycle, IPC, updater, installers, workflows, artifacts, signatures, release fail-closed paths |
| [11 Accessibility, responsive, visual, and performance](11-accessibility-responsive-visual-performance.md) | Cross-cutting UI quality | WCAG, keyboard, screen readers, reduced motion, contrast, viewport/zoom, visual regression, performance |
| [12 Automated suites, environments, and evidence](12-automated-suite-environments-and-evidence.md) | Test operations | Commands, fixtures, fakes, isolation, expected counts, triage, repeatability, evidence retention |
| [13 Route and control traceability](13-route-control-traceability-matrix.md) | Completion audit | Source-derived inventories matched to owning test IDs and automation/manual status |
| [14 Execution report](14-execution-report.md) | Release candidate evidence | Commands executed, results, browser proof, blocked external cases, residual risks, sign-off |

## Priority policy

### P0 — release stopping

- Data loss, data-directory corruption, cross-product data bleed, or unrecoverable migration.
- Authn/authz bypass, secret disclosure, remote exposure of loopback-only control, arbitrary file access, or command injection.
- Gate allow/deny inversion, contradictory spoken consent accepted, destructive action without explicit confirmation, or mobile revocation bypass.
- Wrong-device input, Workbench control sent to an unseen surface, updater pointed at an inherited/untrusted repository, or package corruption.
- Application cannot launch, create a first operator, open a workstream, send a direction, render a response, or recover from an interrupted run.

### P1 — supported behavior stopping

- Any documented route or visible control does not work on a supported platform or state.
- Critical content/control clips at 390px, loses keyboard focus, lacks an accessible name/state, or becomes pointer-only.
- Incorrect persistence, stale state overwriting a newer mutation, duplicate submission, replay/idempotency failure, or unrecoverable retry.
- Engine, capability, Cadence, Webhook, Workbench, Relay, or package lifecycle differs from documented behavior.
- Public product vocabulary, identity, legal route, privacy claim, or release destination is wrong.

### P2 — non-blocking only with explicit acceptance

- Visual/token inconsistency that does not hide or misstate behavior.
- Rare recovery or performance degradation with a safe workaround.
- External provider variation outside Helmryth's control when the failure is explicit, bounded, and recoverable.

## Environment matrix

| Environment | Required purpose | Minimum setup | Evidence |
|---|---|---|---|
| Browser development shell | Fast renderer/API verification | Node 24, pnpm, isolated `HELMRYTH_DATA_DIR`, Vite and harness on loopback | Browser screenshots, DOM snapshots, console/network log |
| macOS packaged arm64 | Primary desktop integration | Signed or ad-hoc test package, Accessibility/Screen Recording/Microphone permissions | App logs, permission screenshots, DMG/ZIP hashes |
| macOS packaged x64 | Intel artifact compatibility | x64 runner or verified VM | Package verification and launch log |
| Windows 11 x64 | NSIS, update, path, named pipe, and security behavior | Clean VM plus signed/unsigned policy state | Installer log, Event Viewer excerpt, artifact hashes |
| Ubuntu 24.04 Xorg x64 | AppImage/DEB, CUA hold, desktop integration | GNOME Xorg, Xvfb/xdotool for automated smoke | Package smoke log, desktop file validation, screenshots |
| iOS simulator | Navigation, decoding, persistence, accessibility | Xcode, xcodegen, generated HelmrythCompanion project | XCTest/xcodebuild report, screenshots |
| Physical iPhone | Pairing, backgrounding, notifications, widgets, live activity | Provisioned build and reachable Helmryth host | Screen recording, device/host logs |
| Physical Android device | USB authorization and input fidelity | ADB-capable device, trusted host, debug prompt | Screen recording, ADB state log, before/after screenshots |
| Registry Worker local/miniflare | Account, Node, Reach, auth, D1 | Wrangler and test bindings | Vitest and Wrangler dry-run output |
| Conduit Worker local/miniflare | Capability inventory, sessions, MCP | Wrangler, test Composio responses | Vitest and Wrangler dry-run output |
| Owner-controlled release repository | Guarded update/release proof | `HELMRYTH_RELEASE_REPO`, scoped PAT, draft release | `app-update.yml`, release asset list, workflow URL |

## Test identities and fixtures

Use distinct non-production identities so evidence cannot be confused with real work:

- User profile: `QA Helm` with `qa-helm@example.test` only in isolated fixtures.
- Operators: `Rivet QA`, `Cairn QA`, `Vesper QA`.
- Crew: `QA Foundry`.
- Work folders: temporary directories created per run; never a real repository unless that case explicitly tests existing-repository safety.
- Capability aliases: `work-qa` and `personal-qa` against sandbox accounts only.
- Webhook IDs, pairing tokens, Node credentials, and secrets: server-generated test values; never copied into committed Markdown evidence.
- Time: freeze or record timezone/clock when validating Cadences, notification labels, expiry, and update freshness.

All automated tests must isolate home/data/ports. Manual test cleanup must revoke OAuth grants, pairing tokens, tunnels, temporary Nodes, Webhooks, Workbenches, and release drafts created by the case.

## Execution order

### Gate A — static integrity

1. Clean dependency install with the frozen lockfile.
2. Typecheck renderer, server, cloud packages, and Swift core.
3. Run brand, contrast, QA-coverage, workflow syntax, config-schema, deep-link, and release-target checks.
4. Build renderer, server bundle, companion bundle, docs, Registry dry-run, and Conduit dry-run.

Any failure stops later release evidence until diagnosed.

### Gate B — automated behavior

1. Root Vitest suite and floor enforcement.
2. Conduit and Registry tests.
3. Updater, desktop viewer, package link, save-file, boot-probe, and packaged-server Node suites.
4. Swift package tests and Xcode simulator tests where XCTest/Xcode are available.
5. Linux X11 and package smoke on the supported runner.

### Gate C — browser and accessibility

1. Fresh onboarding at 1440px and 390px.
2. Populated Roster, Workstream, Operations map, Cadences, Capabilities, System, Trace, and Workbench states.
3. Keyboard-only traversal, modal focus containment/restoration, Escape/cancel, live regions, disabled states, and reduced-motion mode.
4. Console/network error review and horizontal-overflow check at every target width.

### Gate D — native/platform integrations

Run macOS, Windows, Ubuntu, iOS, Android, Box, VPS, OAuth, Registry/Reach, and release-repository cases only in provisioned environments. Attach evidence and mark unprovisioned cases `Blocked — external prerequisite`; never infer a pass from unit mocks.

### Gate E — release candidate

1. Re-run all static and automated gates on the exact release source state.
2. Package each target with publishing disabled.
3. Verify artifacts, signatures, manifests, update target, licenses, clean install, upgrade, uninstall, and rollback.
4. Upload only to a draft owner-controlled release after the guarded checks pass.
5. Publish only after P0/P1 closure and recorded approval from engineering, security, QA, and product owners.

## Cross-surface production journeys

The domain documents contain atomic tests. These journeys prove that state remains correct across boundaries.

### JRN-001 — first launch to completed run

1. Launch with a nonexistent isolated data directory.
2. Verify Helmryth creates its directory without moving neighboring product data.
3. Complete Identity and Engines onboarding, skip Mobile, and verify Rivet is the first operator.
4. Choose `Build or ship`, send a direction, observe run presence, capability activity, and final response.
5. Restart the app and verify the Workstream, run state, model, Gate policy, and unread state persist.

Expected: no old product storage is mutated; no telemetry initializes without explicit consent and an HTTPS owned endpoint; every consequential request stops at a Gate.

### JRN-002 — crew delegation with Gate and recovery

1. Create Cairn and Vesper, then create `QA Foundry`.
2. Elect a lead operator, delegate a bounded run, and observe handoff status in the workstream and Operations map.
3. Trigger a Gate from the delegated operator, deny it, and verify the operator receives the denial and continues or fails explicitly.
4. Disconnect and reconnect the browser during the run; verify SSE replay is exact and not duplicated.

### JRN-003 — capability account lifecycle

1. Configure a sandbox capability service and connect two labeled accounts.
2. Start a fresh run, select the intended alias, and verify the engine receives only authorized inventory.
3. Disconnect one account, verify upstream revocation, retain the second account, and confirm stale cached inventory never claims certainty.
4. Remove the managed service and verify fail-closed self-hosted guidance.

### JRN-004 — Cadence and Webhook convergence

1. Create a paused Cadence and an independent Webhook for Rivet.
2. Verify unconfirmed chat-created Cadences remain inert.
3. Confirm and run the Cadence, then deliver a signed Webhook payload twice.
4. Verify separate runs, deduplicated Webhook delivery, receipts, notifications, Trace records, and execution-surface selection.

### JRN-005 — Workbench control handoff

1. Configure an Isolated or Remote Workbench and open the viewer in observation mode.
2. Let Rivet acquire control, then take controls as the user and verify operator input is withheld.
3. Return controls, switch panes in Split Workbench, and verify exactly one controller.
4. Force a reload, invalid URL, lease expiry, and runtime loss; verify fail-closed state and recoverable actions.

### JRN-006 — Helmryth Mobile revocation

1. Pair an iPhone using a fresh code and verify default permissions exclude cloud Workbench control.
2. Follow a Workstream, answer a Gate, and mark it read.
3. Revoke the device from System while it is reconnecting.
4. Verify every subsequent request and stream reconnect is rejected and the device returns to pairing.

### JRN-007 — guarded release

1. Prove missing and malformed `HELMRYTH_RELEASE_REPO` fail before packaging.
2. Supply an owner-controlled `owner/repo`, package with `--publish never`, and verify the generated private builder config is removed.
3. Verify `app-update.yml`, artifacts, blockmaps, hashes, licenses, and draft-release destinations.
4. Exercise updater check, download, staging, install failure, concurrency, and rollback states without contacting an inherited endpoint.

## Evidence retention

Retain evidence under an execution-specific directory outside committed source unless it is intentionally added to [14-execution-report.md](14-execution-report.md):

- command transcript with exit status;
- JSON/JUnit test reports;
- browser DOM snapshots, screenshots, console and network logs;
- package file list, hashes, signature/notarization output, and update manifest;
- redacted server/Electron/companion/Worker logs;
- device screen recordings for iOS/Android/permission flows;
- links to CI runs and draft releases.

Evidence must not contain provider keys, pairing tokens, Webhook secrets, private workstream content, precise personal identifiers, or signed temporary viewer URLs.

## Failure handling and reruns

1. Record the first failure before changing state.
2. Classify product defect, test defect, environment defect, provider outage, or unsupported prerequisite.
3. Reproduce with the narrowest owning case.
4. Preserve logs and exact inputs; redact secrets only, not error semantics.
5. Fix and run the narrow case, its domain suite, and the release gate affected by the change.
6. A flaky pass is not a pass. Define and fix the race or quarantine the case with owner, reason, and expiry before release acceptance.

## Sign-off record

The release execution report must record:

| Role | Required decision |
|---|---|
| Engineering | Source, build, migration, API, and platform behavior accepted |
| QA | P0/P1 closure, automated counts, manual matrix, evidence completeness accepted |
| Security | Auth, secrets, data, supply chain, updater, mobile, and cloud boundaries accepted |
| Product/design | Vocabulary, states, accessibility, responsive behavior, and public docs accepted |
| Release owner | Destinations, signing identities, artifacts, staged update, and rollback accepted |

No role may sign on behalf of an unavailable external prerequisite. Those cases remain blocked until executed.
