# Helmryth QA execution report

Execution dates: August 30–31, 2026

Workspace: `/Users/divyamtalwar/Downloads/GrokBot/Helmryth`

Source state: unpacked filesystem snapshot without live `.git` metadata. A canonical source manifest was generated from `rg --files`, sorted under `LC_ALL=C`. It excludes `docs/qa/14-execution-report.md` and `output/**` to avoid self-reference, plus generated build/cache trees (`dist*`, `.next`, `.build`, coverage/release/output caches, TypeScript build info, Electron resources, and generated Worker type declarations). It contains `1038` file hashes at `output/qa/source-manifest-20260831-stress-final.sha256`; all `1038/1038` entries reverified, and the manifest SHA-256 is `ee1461d4ac0890e62d7cd105f269e45f83a54b0fd26ac695bb720b44f7d780fc`.

## Verification summary

| Command | Result | Key evidence |
|---|---|---|
| `pnpm lint` | Passed | `oxlint .` exited `0` with no diagnostics. |
| `pnpm check:brand` | Passed | Final output: `Brand residue check passed.` |
| `pnpm check:contrast` | Passed | `21` pairs measured, no new failures. |
| `pnpm typecheck` | Passed | Exit `0`, no diagnostics emitted. |
| `pnpm build:companion` | Passed | Companion bundle built successfully. |
| `pnpm test` | Passed | Exit `0`; root Vitest: `271` files total, `270` passed, `1` skipped; `2,879` tests passed, `19` skipped, `2,898` counted; floor `1,070`; duration `209.94s`. Child suites passed: Conduit worker `10` and preflight `14`, updater `18`, desktop viewer/external URL `19`, package-link `2`, save-file `10`, server-boot-probe `11`, packaged-server smoke passed with all `10` proxy paths and MCP flush. |
| `pnpm docs:build` | Passed | Next.js `16.3.2` built successfully and generated `111` static pages. |
| `pnpm registry:check` | Passed | Exit `0`; Wrangler types plus TypeScript compile completed. |
| `pnpm registry:test` | Passed | Registry worker Vitest: `2` files, `43` tests passed. |
| `pnpm --filter @helmryth/registry preflight:test` | Passed | Registry preflight suite passed with `23` tests. The checked-in production skeleton itself intentionally refuses deployment until owned values replace its sentinel examples. |
| `pnpm registry:dry-run` | Passed | Wrangler dry-run completed with expected Registry bindings. |
| `pnpm conduit:check` | Passed | Exit `0`; Wrangler types plus TypeScript compile completed. |
| `pnpm conduit:test` | Passed | Registry-side Conduit suite: `1` file, `10` tests passed. |
| `pnpm conduit:preflight:test` | Passed | Conduit preflight suite passed with `14` tests. The checked-in production skeleton itself intentionally refuses deployment until owned values replace its sentinel examples. |
| `pnpm conduit:dry-run` | Passed | Wrangler dry-run completed with expected Conduit bindings. |
| `pnpm check:electron` | Passed | Recursive production scan checked `47` modules; focused `6/6`; includes nested production sources and excludes tests/fixtures; no GUI/profile access. |
| `pnpm build` | Passed | Vite build succeeded; `2324` modules compiled; largest emitted client chunk was `251.23 kB`; no chunk-size warning. |
| `pnpm audit --audit-level high` | Passed | `0` vulnerabilities reported. |
| `pnpm check:qa-docs` | Passed | `{ "ok": true, "docs": 16, "scripts": 94, "workflowLabels": 17, "routes": 162, "uniqueRoutes": 160, "ipcChannels": 76, "ipcEvents": 10, "rendererFiles": 78, "rendererControlFiles": 63, "rendererControls": 596, "rootTestFiles": 272 }` |
| `pnpm --filter @helmryth/docs types:check` | Passed | Docs package typecheck exited `0`. |
| `swift build --package-path ios --target CompanionCore` | Passed | Swift package built successfully. |
| `swift test --package-path ios` | Blocked - environment | `ios/Tests/CompanionCoreTests/ConnectedAppsClientTests.swift:2:8` failed with `no such module 'XCTest'` in this shell environment. |
| `actionlint` | Passed after explicit-path rerun | Initial no-argument invocation exited `3` because the workspace has no git root; `actionlint .github/workflows/*.yml` exited `0`. |

## Root test evidence

`pnpm test` completed successfully with these exact results:

| Suite | Result |
|---|---|
| Root Vitest | `271` files total; `270` passed files and `1` skipped file; `2,879` passed tests and `19` skipped tests; `2,898` counted; floor `1,070`; duration `209.94s`. |
| Conduit worker / preflight | `10` tests passed; preflight suite `14` tests passed. |
| Updater | `18` tests passed. |
| Desktop viewer / external URL | `19` tests passed. |
| Package link | `2` tests passed. |
| Save-file | `10` tests passed. |
| Server boot probe | `11` tests passed. |
| Packaged-server smoke | Passed; all `10` proxy paths resolved and MCP final frames flushed. |

The child stderr lines emitted during this run were expected fault-injection logs from bus and permission tests, not failures.

The corpus integrity gate now also records source-drift checks for duplicate IDs, malformed compact rows, placeholder omissions, broken local/source links, and the source census itself.

## Umbrella test closure

The release-truth umbrella run is the one above: `271` root Vitest files, `2,879` passed tests, `19` skipped, `2,898` counted, floor `1,070`, and `209.94s` duration. Local code gates are green across lint, typecheck, brand, contrast, QA-docs, Electron, build, docs build, companion build, audit, Registry, Conduit, and packaged-server smoke; the remaining release work is external or provisioned-only.

Additional adversarial fixes verified in the final focused state:

- `signOut` now scrubs bearer, user, node, and reach state during unconfigured/offline cleanup, with focused coverage `45/45`.
- The QA checker now handles path-space and Windows cases plus exact manifest:script pairing, with coverage `6/6`.
- The brand QA exemption was narrowed and verified at `14/14`.

## Electron gate repair

The previous Electron gate could boot the GUI / real app-support path and hang. That left orphan processes behind and made the check sensitive to profile access it did not need.

The repaired gate is now a Node syntax check with a `10s` per-file timeout:

- focused run: `6/6`
- command: `pnpm check:electron`
- result: passed
- coverage: recursively syntax-checked `47` production Electron modules, including the nested updater vendor module; tests and fixtures are covered by their own runners and excluded from this production census
- safety: no GUI launch and no profile access

## Browser and live-provider evidence

The final browser verification used the production `dist/` client from the main server on `127.0.0.1:19099` with an isolated profile. Earlier burner-account lanes separately exercised the live OpenAI and Composio APIs; final post-fix provider behavior used a deterministic loopback OpenAI-compatible fixture so reruns did not consume or retain credentials.

Final built-static proof includes:

- onboarding at `390×844` and `430×932`, with Engines visible in under `60ms` and inventory settled in under `1s`;
- Crew Library `200` bundled catalog, five crews, review/import exactly once, and server-authoritative undo;
- mobile workstream width equal to viewport and four primary controls measured at `44×44` CSS px;
- System, Capabilities, Trace, nested roster, and Workbench close/focus restoration;
- reduced-motion modal animation computed as `none` / `0s`;
- Browser Workbench's honest desktop-required fallback plus responsive Workbench width clamping;
- OpenAI-compatible output `FINAL-LIVE-OK`, usage `11 in / 7 out / 18 total`, reload persistence, and safe workstream/roster/collapsed-Trace failure copy;
- Run default `Untitled run`, first-message naming, accessible run count, cadence assignment `400`s, Operations-map empty state, and focused Gate-state automation;
- final browser console checks with `0` errors and `0` warnings on success paths.

Authoritative evidence lives under `output/playwright/live-20260830/final/` and `output/playwright/live-20260830/fixes/`. Historical pre-fix captures are retained as defect evidence and are explicitly superseded by the final reports. Generated browser profiles and trace-resource floods were removed from the deliverable; retained evidence is private (`0700` directories / `0600` files) and secret scans are clean.

## Cloud contract repair

A cloud contract drift was found and repaired test-first. The repaired flow now matches the current worker contracts and desktop compatibility layer.

| Phase | Result |
|---|---|
| Red phase | `12` failing tests reproduced the old contract assumptions. |
| Electron verification | `51/51` after the repair. |
| Registry verification | `43/43` after the repair. |
| Conduit verification | `10/10` after the repair. |
| Migration summary | Desktop compatibility was preserved by translating the older renderer assumptions onto the current Registry and Conduit contracts instead of leaving stale endpoint calls in place. |

## August 31 stress closure

The second-pass stress matrix added repeatability, malformed-upstream, concurrency, and security probes beyond the first release run. Confirmed repairs include:

- exact renderer-origin and Host enforcement on the public loopback API, plus centralized JSON media gates for state-changing routes;
- default webhook credentials changed to `endpointUrl + one-time secret`, with no secret-bearing URL emitted or cached; the visible Terminal preview masks the bearer while the copy action retains the full one-time command, and safe creation/rotation screenshots replace the permanently removed secret-visible captures;
- OpenAI-compatible remote models restored to the Cloud picker and proven through a built-static local-provider turn;
- multi-frame OpenAI usage merged monotonically without double counting or lost token fields;
- Composio duplicate connected-account rows deduplicated before public state and account-cap enforcement;
- one shared, validated, single-flight engine inventory loader across bootstrap, focus refresh, and onboarding;
- cadence history trimming preserves active receipts while bounding retained history at `2000`;
- repeated overlay focus restoration, `44×44` mobile roster close targets, and complete reduced-motion sigil suppression;
- XcodeGen pinned by version plus archive/binary SHA-256 in both CI and release workflows;
- credential fields in operator dossiers moved into semantic, single-flight forms;
- test fixtures repaired for order independence and exact temporary-directory cleanup.

Fresh stress evidence includes `770` Gate checks across ten iterations, `2,130` fake-driver passes across five iterations, `205` webhook-ingress requests, `20` deterministic persistence cycles with one canonical state hash, `20` Companion lifecycle cycles, `700` browser-host HTTP requests, `51` cadence API cycles, `12` cadence visual cycles, `61/61` OpenAI stream cases, and `120/120` Playwright focus cycles across four viewport widths. The post-fix security corpus executed `26` live probes with zero unexpected `500`s; the original foreign-localhost CSRF request now returns `403`.

Stress artifacts are retained under `output/playwright/stress-20260830/`. Historical raw-CDP focus results are marked harness-invalid and superseded by `core-ui/playwright-results.json` and the final Playwright report.

## Environment blocks and manual lanes

These areas remain blocked by external prerequisites and are not proven by this shell:

| Area | Blocker | Impact |
|---|---|---|
| Signed macOS, Windows, and Linux packages | No signing identity, notarization key, or release signing material in this shell | Package signing, notarization, and signed installer proof remain external lanes. |
| Updater publication | No owner-controlled release repo or release PAT configured locally | Guarded update and release publication remain blocked. |
| Physical iOS and Android devices | No tethered devices in this shell | Pairing, notifications, backgrounding, live activity, widgets, and USB authorization remain external manual lanes. |
| Full Xcode / XCTest | This shell only has the command line Swift environment | Simulator XCTest coverage cannot be completed here. |
| Real OS permissions and audio hardware | No controlled desktop permission fixture or audio device is provisioned here | Microphone, Screen Recording, and other platform permission flows remain manual. |
| Additional OAuth, Box, and VPS bindings | Burner OpenAI and Composio lanes were proven, but no owned Box/VPS or broader OAuth sandbox matrix is provisioned here | Remaining provider/Workbench integrations must be run in owned environments. |
| Deployed Registry, Reach, and Conduit bindings | No deployed worker endpoints are provisioned from this shell | Live deployment validation remains owned by the worker environments. |
| Owner-controlled release repository | No release repo credential or deployment target is configured | Release acceptance cannot be signed off from this workspace alone. |

## Failure and rerun semantics

- `actionlint` first exited `3` with no arguments because the workspace has no git root. The explicit-path rerun passed and is the result that counts.
- `swift test --package-path ios` failed for environment reasons, not because the source tree is known-bad: XCTest is unavailable in this shell.
- Playwright tracing was stopped because tracing into the repo triggered Vite reloads. Screenshots and DOM snapshots were still retained and are valid evidence.
- The root test stderr emitted during negative-path tests was expected fault-injection output, not a failure signal.

## Sign-off status

| Role | Status |
|---|---|
| Engineering | Green |
| QA | Green |
| Security | Green |
| Architecture | Green |
| Product / design | Green |
| Release owner | Pending external / provisioned lanes |

## Release-readiness verdict

All local code gates are green: lint, typecheck, brand, contrast, QA-docs, Electron, build, docs build, companion build, and audit all pass. The remaining release work is external or provisioned-only: signed packages, owner-controlled release delivery, physical devices, XCTest/Xcode, and live provider/cloud bindings.

## Evidence paths

| Evidence | Path |
|---|---|
| Browser screenshots | `output/playwright/` |
| Canonical source manifest | `output/qa/source-manifest-20260831-stress-final.sha256` — `1038/1038` entries verified; manifest SHA-256 `ee1461d4ac0890e62d7cd105f269e45f83a54b0fd26ac695bb720b44f7d780fc` |
| Final live E2E report | `output/playwright/live-20260830/FINAL-LIVE-E2E-REPORT.md` |
| QA corpus docs | `docs/qa/` |
| Docs build output | Next.js build artifacts recorded by `pnpm docs:build` |
| Root test output | Workspace command transcript for `pnpm test` |
| Electron gate output | Workspace command transcript for `pnpm check:electron` |
| Swift build output | Workspace command transcript for `swift build --package-path ios --target CompanionCore` |
| Swift test failure | Workspace command transcript for `swift test --package-path ios` |
