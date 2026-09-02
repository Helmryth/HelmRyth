# Electron, packaging, CI, and release QA specification

This chapter is the release gate for the Electron shell, preload bridge, native IPC, platform packaging, GitHub Actions workflows, updater configuration, artifact metadata, and guarded cross-repository release lane. It is derived from `electron/main.mjs`, `electron/preload.cjs`, `electron-builder.yml`, `scripts/package-release.mjs`, `scripts/release-builder-config.mjs`, `scripts/verify-update-target.mjs`, and `.github/workflows/{ci,package-linux,package-win,release}.yml`.

## Source census

| Inventory | Count / source |
|---|---|
| Native IPC handlers/events | 76 registrations total: 74 `ipcMain.handle` channels plus 2 `ipcMain.on` channels across `electron/main.mjs`, `electron/updater.mjs`, `electron/cua.mjs`, and `electron/android-device.mjs`, including the Reach and Registry compatibility aliases exposed through preload. |
| Packaged desktop artifacts | macOS `dmg` + `zip` for `arm64` and `x64`; Windows `nsis` + `zip` for `x64`; Linux `AppImage` + `deb` for `x64`, plus stable-named copies generated in workflow lanes. |
| Release workflows | `ci.yml`, `package-linux.yml`, `package-win.yml`, and `release.yml`. |
| Script gates | `check:brand`, `check:contrast`, `check:electron`, `package:prepare`, `package:release:*`, `release:config:check`, `verify-update-target.mjs`, `verify-linux-package.mjs`, `smoke-packaged-server.mjs`, `smoke-linux-package.mjs`, `smoke-deb-upgrade.mjs`, `regenerate-blockmaps.mjs`, and `regenerate-mac-feed.mjs`. |

## Global native and release invariants

- `contextIsolation` remains on and the renderer sees only `window.helmryth`.
- Every IPC route is exercised with a valid renderer sender and an invalid or foreign sender when the handler scopes ownership.
- Packaged artifacts must ship the built UI, compiled server, companion bundle, skills, required native helpers, and all third-party license/provenance files named in `electron-builder.yml`.
- No package or release lane may bake a previous-owner or inherited update feed. The base `electron-builder.yml` must remain `publish`-free; release-only destinations are injected temporarily from `HELMRYTH_RELEASE_REPO`.
- Every release workflow must be reproducible from one exact pinned commit across platforms.
- Signing and notarization gates fail before publication, not after. A successful build with a broken signature or wrong update target is a release failure.

## Fresh Electron gate evidence

The original `check:electron` implementation delegated `--check` to the Electron application binary and depended on `ELECTRON_RUN_AS_NODE=1`. During this QA pass that contract failed on macOS: the gate launched Helmryth, reached the real application-support profile, and did not terminate. The spawned process tree was stopped, and the gate was repaired so this failure mode cannot recur.

- `scripts/check-electron.mjs` now invokes `process.execPath --check` and never resolves or starts the Electron executable.
- Every module check has a hard `10,000 ms` timeout and reports the offending filename on failure.
- `scripts/check-electron.test.mjs` proves recursive production-module discovery, nested vendor coverage, test/fixture exclusion, Node-only invocation, timeout wiring, syntax-error reporting, the empty-set failure, and prompt CLI completion: `6/6` tests passed.
- `pnpm check:electron` completed in `2.82s` and syntax-checked all `44` production `electron/**/*.mjs` and `electron/**/*.cjs` modules—including the vendored updater bundle that `scripts/bundle-updater.mjs` emits at package time—without starting the app or touching a product profile. Test, spec, fixture, generated, dependency, and build-output modules are deliberately excluded.

Treat any future GUI launch, application-data access, or unbounded wait from this static gate as a P0 test-infrastructure regression.

## Electron bootstrap, shell lifecycle, and deep links

| ID | Surface / route | Trigger and setup | Expected assertions | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|
| PKG-SHELL-001 | App identity bootstrap | Cold start in dev and packaged app | `app.setName`, process title, desktop name, app id, icon, protocol, and userData/log paths all resolve to Helmryth identity; no old product identity leaks to Dock/taskbar, desktop file, or logs | `electron/main.mjs`, packaged screenshot, `electron-builder.yml` | P0 | Manual — executable |
| PKG-SHELL-002 | Single-instance lock | Launch twice, deep link while running | Second launch focuses the existing window, does not start a second server, and forwards any `helmryth://install` payload to the active instance | `electron/single-instance.node-test.mjs`, deep-link smoke | P0 | Automated — passing |
| PKG-SHELL-003 | Packaged server boot | Signed and unsigned packages, plus browser dev shell | Harness server binds a healthy port, serves `/api/health`, and identifies as Helmryth before renderer use; fallback ports remain safe when default port is occupied by another process | `electron/server-boot-probe.node-test.mjs`, workflow packaged-server smoke | P0 | Automated — passing |
| PKG-SHELL-004 | Pending package install deep link | Launch with command-line package URL and runtime `open-url` | Valid `helmryth://install?package=<https-package-url>` payload queues and delivers once after main-frame load; invalid scheme/host/path/file type is rejected | `electron/package-link.node-test.mjs`, manual deep-link trace | P0 | Automated — passing |
| PKG-SHELL-005 | Window state persistence | Resize, move, maximize, crash during write | Only the current window's normal bounds and maximized state persist; temporary state file cleanup survives interrupted writes | `electron/window-state.test.mjs`, manual relaunch | P1 | Automated — passing |
| PKG-SHELL-006 | Unread badge | macOS, Windows, Linux unread transitions | Badge/overlay count matches visible unread conversations only and clears safely | `src/lib/unread.test.ts`, platform screenshots | P1 | Manual — executable |

## Preload bridge and renderer-safe IPC surface

| ID | Bridge area | Trigger and setup | Expected assertions | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|
| PKG-BRIDGE-001 | `window.helmryth` exposure | Browser shell, desktop shell, malformed preload attempts | Only the documented Helmryth bridge exists; Node, `ipcRenderer`, and raw Electron APIs stay hidden from renderer JavaScript | `electron/preload.cjs`, browser security inspection | P0 | Manual — executable |
| PKG-BRIDGE-002 | Capabilities and shell utilities | `getCapabilities`, `onCapabilitiesChanged`, `openExternal`, `applySkin`, `setUnreadCount` | Returned values are JSON-safe and scoped; event unsubscribe works; `openExternal` validates URLs; `applySkin` accepts only known Helmryth light identity | `electron/skin-overlay.test.mjs`, `src/lib/desktop.test.ts` | P1 | Automated — passing |
| PKG-BRIDGE-003 | Folder, save, diagnostics | `pickFolder`, `saveFile`, `exportDiagnostics` | Dialog cancellation is non-error; path validation and error stripping behave exactly as UI expects; diagnostics file is redacted and named safely | `electron/save-file.node-test.mjs`, `electron/diagnostics.test.mjs` | P0 | Automated — passing |
| PKG-BRIDGE-004 | Permissions and screen preview | `permStatus`, `permRequestMic`, `permOpenSettings`, `screenFrame`, `beginScreenPreviewIntent` | Permissions never claim more certainty than the platform allows; screen preview intent arms exactly one request; `screenFrame` stays view-only | `electron/screen-preview.test.mjs`, manual macOS and Linux proof | P0 | Manual — executable |
| PKG-BRIDGE-005 | Speech and recorder | `speechStart/Stop/Finish`, transcript/end events, recorder permissions/start/stop/save | Event ordering is deterministic, cleanup runs on stop/unmount, and saved recordings stay privacy-filtered and app-owned | `electron/skill-recorder.test.mjs`, `src/components/CallView.test.ts` | P1 | Automated — passing |
| PKG-BRIDGE-006 | Updater bridge | `update:get-state/check/download/install` in packaged and dev builds | Dev/browser has no updater bridge; packaged bridge reflects current state immediately and serializes transitions correctly | `electron/updater-coordinator.node-test.mjs`, `electron/update-channel.node-test.mjs` | P0 | Automated — passing |
| PKG-BRIDGE-007 | Workbench bridges | `desktopViewer`, `desktopWorkspace`, `browser`, `androidDevice`, `localControl` | Ownership checks reject foreign senders; invalid context ids and bad URLs fail closed; unsubscribe removes listeners | `electron/desktop-viewer.node-test.mjs`, `electron/desktop-workspace.node-test.mjs`, `electron/android-device.test.mjs`, `electron/cua-linux.test.mjs` | P0 | Automated — passing |
| PKG-BRIDGE-008 | Companion and registry bridges | `reach:*`, `registry:*`, deprecated aliases | Alias behavior remains compatible without exposing extra power; returned state is secret-free; concurrent mutations serialize | `electron/managed-companion-*.test.mjs`, `electron/registry-client.test.mjs`, `src/components/CompanionSection.test.ts` | P0 | Automated — passing |
| PKG-BRIDGE-009 | Credential bridge | `credential:set`, AssemblyAI key routes | OS-backed encrypted storage is used when packaged; wrong values and unavailable keychain states fail cleanly without destroying prior valid secrets | `electron/secure-credentials.test.mjs`, `electron/secure-credential-state.test.mjs`, `electron/assemblyai.test.mjs` | P0 | Automated — passing |

## Native browser, viewer, desktop workspace, and updater handlers

| ID | Native area | Trigger and setup | Expected assertions | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|
| PKG-NATIVE-001 | Browser host + surface | Open per-operator Browser Workbench, navigate, profile switch, close | Native surface overlays only the intended bounds, honors profile partitions, pauses when the person takes control, and tears down on close | `electron/browser-host.cjs`, `electron/browser-surface.test.mjs`, `electron/browser-snapshot.test.mjs` | P0 | Automated — passing |
| PKG-NATIVE-002 | Desktop viewer | Open live VNC/noVNC viewer, close, wrong owner sender | Viewer validates URL origin, tracks context ownership, closes idempotently, and does not leak one operator's viewer to another | `electron/desktop-viewer.node-test.mjs` | P0 | Automated — passing |
| PKG-NATIVE-003 | Desktop workspace | Open split/dedicated workspace views, relayout, set interactive, close | Embedded native views remain bounded to app-owned layouts, preserve one interactive pane, and close only their own context | `electron/desktop-workspace.node-test.mjs` | P0 | Automated — passing |
| PKG-NATIVE-004 | Linux CUA runtime | Enable, retry, disable, bad candidate, wrong mode/owner/version | Only reviewed binaries and staged trees are accepted; invalid candidates fail closed; disable interrupts only Host-controlled operators | `electron/cua-linux-runtime.test.mjs`, `electron/cua-linux-bundle.test.mjs`, `scripts/cua-linux-release.test.mjs` | P0 | Automated — passing |
| PKG-NATIVE-005 | Android device bridge | Physical USB device connect, status, frame, input | Network ADB stays excluded; input is scoped to selected serial; disconnect recovers without stale frame reuse | `electron/android-device.test.mjs`, manual physical device run | P1 | Manual — executable |
| PKG-NATIVE-006 | Updater coordinator | Check, download, install, error, concurrency, stable feed | Update state machine coalesces checks, clamps progress, sanitizes errors, and never uses an unowned feed | `electron/updater-coordinator.node-test.mjs`, `electron/update-channel.node-test.mjs` | P0 | Automated — passing |

## Artifact composition and packaging matrix

| ID | Artifact | Trigger and setup | Expected assertions | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|
| PKG-ART-001 | `electron-builder.yml` base config | Static inspection | `productName`, `appId`, artifact names, protocol, files, extra resources, and platform metadata all use Helmryth identity; base config contains no `publish` key | `electron-builder.yml`, `scripts/release-builder-config.test.mjs` | P0 | Automated — passing |
| PKG-ART-002 | Packaged resource tree | `package:prepare`, unpacked trees on all platforms | `server/index.js`, `ui/index.html`, companion bundle, skills, cloudflared, licenses, and expected helpers exist in the packaged resource tree | Windows and Linux workflow checks, mac smoke gate | P0 | Automated — passing |
| PKG-ART-003 | cloudflared provenance | All packaged targets | Exact bundled hash and version match the reviewed binary; license and README ship alongside | Windows and mac workflows, packaged file hashes | P0 | Automated — passing |
| PKG-ART-004 | macOS helper apps and binaries | `package:release:mac` | Speech helper, recorder helper, CUA driver, CUA SDK, and cloudflared are present with expected architecture split and codesign identity | `release.yml` mac lane, `scripts/cua-mac-arches.test.mjs` | P0 | Manual — executable |
| PKG-ART-005 | Windows unpacked tree and installer | `package:release:win` | NSIS installer and unpacked resources contain the app, server, UI, update manifest, and cloudflared; packaged server boots under plain Node | `package-win.yml`, `release.yml` windows lane | P0 | Automated — passing |
| PKG-ART-006 | Ubuntu package tree | `package:release:linux:offline` | AppImage and DEB include staged x64 CUA runtime, cloudflared, desktop file, icon, `chrome-sandbox`, and package metadata; install/upgrade/uninstall remain safe | `package-linux.yml`, `scripts/verify-linux-package.mjs`, `scripts/smoke-deb-upgrade.mjs` | P0 | Automated — passing |
| PKG-ART-007 | Stable-named release copies | Workflow artifact assembly | Stable download names (`Helmryth.dmg`, `Helmryth-intel.dmg`, `Helmryth-setup.exe`, `Helmryth.AppImage`, `Helmryth-amd64.deb`) are copied from the exact versioned artifacts and hashed after the copy | `release.yml`, `package-linux.yml` | P1 | Manual — executable |

## CI and release workflow gates

| ID | Workflow lane | Trigger and setup | Expected assertions | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|
| PKG-CI-001 | `ci.yml` | Pull request or push to `main` | Node 24 + pnpm + frozen lockfile install + `check:brand` + `typecheck` + `test` + `check:electron`; Ubuntu also runs a production Vite build | `.github/workflows/ci.yml` | P0 | Manual — executable |
| PKG-CI-002 | `package-linux.yml` | Manual workflow dispatch | Ubuntu 24.04 builds from explicit ref, verifies `HELMRYTH_RELEASE_REPO`, stages offline CUA, packages, verifies contents, simulates in-place upgrade, launches smoke, and uploads artifacts only after success | `.github/workflows/package-linux.yml` | P0 | Manual — executable |
| PKG-CI-003 | `package-win.yml` | Manual workflow dispatch | Windows builds from explicit ref, packages with explicit release target, verifies tree, boots packaged server, and uploads installer artifacts | `.github/workflows/package-win.yml` | P0 | Manual — executable |
| PKG-CI-004 | `release.yml` prepare lane | Manual workflow dispatch with `ref` and optional `publish` | Pins one exact commit and version, rejects brand residue, requires release repo + PAT, and refuses to overwrite an already published version | `.github/workflows/release.yml`, `scripts/release-repository.mjs` | P0 | Manual — executable |
| PKG-CI-005 | `release.yml` mac lane | Provisioned Developer ID and Apple API key | Two architectures package from the pinned commit, signatures verify before notarization, both packaged servers smoke, helper paths resolve, artifacts notarize, staple, blockmaps regenerate, and feed refreshes | `.github/workflows/release.yml`, `scripts/regenerate-blockmaps.mjs`, `scripts/regenerate-mac-feed.mjs` | P0 | Manual — executable |
| PKG-CI-006 | `release.yml` windows lane | Provisioned release repo variable | Windows package verifies update target, packaged tree, and packaged server before artifact upload | `.github/workflows/release.yml` | P0 | Manual — executable |
| PKG-CI-007 | `release.yml` linux lane | Provisioned release repo variable | Linux lane mirrors package-linux guardrails, including offline CUA stage and smoke, from the same pinned commit as other platforms | `.github/workflows/release.yml` | P0 | Manual — executable |

## Expanded release-critical scenarios

### `PKG-P0-001` — release target fails closed before expensive work

- **Priority:** P0
- **Execution:** Automated where scripts exist; manual workflow exercise required
- **Platforms:** macOS, Windows, Ubuntu
- **Surfaces:** `scripts/release-builder-config.mjs`, `scripts/package-release.mjs`, `release.yml`
- **Steps:**
  1. Run each release packaging command without `HELMRYTH_RELEASE_REPO`.
  2. Repeat with malformed values such as `repo`, `owner/`, `https://host/repo`, and whitespace.
  3. Repeat with a valid `owner/repo`.
- **Expected:** Invalid or missing release target fails before packaging, does not generate a persistent builder config, and does not mutate any artifact directory; valid target injects the temporary config and cleans it afterward.
- **Evidence:** Script output, temporary-directory absence after run, packaging log.

### `PKG-P0-002` — packaged server starts from the unpacked tree

- **Priority:** P0
- **Execution:** Automated — passing on Windows; manual on macOS/Linux packages
- **Platforms:** macOS, Windows, Ubuntu
- **Surfaces:** unpacked `Resources/server`, `smoke-packaged-server.mjs`
- **Steps:**
  1. Package the app.
  2. Start the compiled server directly from the packaged resource tree using the platform's Node runtime.
  3. Poll `/api/health`.
- **Expected:** The server starts without `node_modules`, serves health, and resolves all proxy helper paths from the packaged tree.
- **Evidence:** Windows workflow log, mac release gate, Linux packaged smoke log.

### `PKG-P0-003` — mac notarization and post-staple feed integrity

- **Priority:** P0
- **Execution:** Manual — external prerequisite
- **Platforms:** macOS release runner
- **Steps:**
  1. Package both mac architectures.
  2. Verify `codesign --verify --deep --strict` before notarization.
  3. Notarize DMG and ZIP artifacts, staple the DMGs and app bundles, re-zip, regenerate blockmaps, and regenerate `latest-mac.yml`.
  4. Verify the post-staple hashes match the feed.
- **Expected:** Any pre-notarization signature defect blocks the lane; any post-staple feed/hash mismatch blocks publication.
- **Evidence:** `release.yml` mac log, notarization receipts, regenerated feed hashes.

### `PKG-P0-004` — Ubuntu in-place upgrade preserves only intended state

- **Priority:** P0
- **Execution:** Automated — passing in workflow lane
- **Platforms:** Ubuntu 24.04 x64
- **Steps:**
  1. Install a previous Helmryth DEB fixture.
  2. Upgrade in place with the new package.
  3. Verify `/opt` and `chrome-sandbox` permissions, launch the packaged app, and purge it.
- **Expected:** Upgrade preserves only intended application data, repairs package-owned modes, and does not strand the host in a broken sandbox state.
- **Evidence:** `package-linux.yml` and `release.yml` Linux logs.
