# Route and control traceability ledger

This document is Helmryth's source-to-QA completion audit. It combines the exact strings consumed by `pnpm check:qa-docs` with independent source-derived counts for renderer controls, navigation, HTTP routes, Companion, Electron, Workers, MCP tools, package scripts, test files, and iOS. A source mapping is not a pass claim: the owning case's `Execution` and `Evidence` fields remain authoritative.

The census was refreshed on 2026-08-30. [TEST-CASE-TEMPLATE.md](TEST-CASE-TEMPLATE.md) defines the required QA vocabulary, and [README.md](README.md) defines release eligibility. This ledger explicitly refuses a zero-gap claim where the corpus or checker differs from source.

## Coverage purpose

Use this file when any of the following change:

- `server/index.ts` route families
- worker or sidecar route families
- `electron/*` IPC channels
- `.github/workflows/*.yml`
- root `package.json` scripts

The owning behavior cases still live in `01` through `12`. This file provides the exact inventory strings that make drift machine-checkable.

## Workflow labels

```text
ci.yml
ci:test
ci:registry
ci:package-linux
ci:ios
package-linux.yml
package-linux:package
package-win.yml
package-win:package
release.yml
release:prepare
release:mac
release:windows
release:linux
release:assemble
```

## Root package scripts

```text
bench:observation
build
build:android-tools
build:browser-snapshot
build:cloudflared
build:companion
build:cua
build:cua:linux
build:cua:linux:offline
build:icons
build:recorder
build:server
build:speech
build:updater
check:brand
check:contrast
check:electron
check:packaged
check:qa-docs
clean
companion
conduit:check
conduit:deploy
conduit:dry-run
conduit:test
conduit:types
dev
dev:desktop
dev:server
docs:build
docs:dev
docs:preview
lint
mcp
package
package:linux
package:linux:dir
package:linux:offline
package:mac
package:prepare
package:release:linux
package:release:linux:offline
package:release:mac
package:release:win
package:win
preview
registry:check
registry:dry-run
registry:test
registry:types
release:config:check
smoke:cua-x11-input
smoke:linux-package
test
test:cua
test:cua-container
test:desktop-viewer
test:package-link
test:packaged-server
test:save-file
test:server-boot-probe
test:updater
test:watch
typecheck
```

## Route checker contract

`scripts/check-qa-coverage.mjs` now checks the canonical 136 main-server routes, 3 webhook-sidecar routes, 10 direct Registry/Reach routes, 3 application-used delegated auth routes, and 10 Conduit routes: 162 source registrations and 160 unique method/path strings because both Workers expose `GET /healthz` and `POST /v1/nodes`. It also enforces cross-file case-ID uniqueness, compact-row field integrity, unfinished-copy rules, local Markdown/source links, package/workflow completeness, and source-census drift for routes, renderer controls, IPC, scripts, and test files. Exact route semantics still require this documented census workflow because the source marker guard deliberately avoids pretending to be a full router parser.
## Canonical Electron inbound IPC strings

```text
android-device:frame
android-device:input
android-device:status
assemblyai:set-key
assemblyai:status
assemblyai:streaming-token
browser:available
browser:back
browser:close
browser:forget-profile
browser:forward
browser:layout
browser:navigate
browser:state
companion-account:request-code
companion-account:retry
companion-account:sign-out
companion-account:state
companion-account:verify-code
companion:cloud-desktop
companion:keep-awake
companion:pairing
companion:revoke
companion:start
companion:state
companion:stop
credential:set
cua:connection
cua:linux-disable
cua:linux-enable
cua:linux-retry
cua:linux-status
cua:permissions
desktop-viewer:close
desktop-viewer:open
desktop-viewer:state-now
desktop-workspace:close
desktop-workspace:layout
desktop-workspace:open
desktop-workspace:set-interactive
desktop:capabilities
desktop:export-diagnostics
desktop:open-external
desktop:pick-folder
desktop:save-file
desktop:skin
desktop:unread-count
engine:open-terminal
perm:open-settings
perm:request-mic
perm:status
reach:cloud-desktop
reach:keep-awake
reach:pairing
reach:revoke
reach:start
reach:state
reach:stop
registry:request-code
registry:retry
registry:sign-out
registry:state
registry:verify-code
screen:frame
screen:preview-intent
skill-recorder:permissions
skill-recorder:save
skill-recorder:start
skill-recorder:stop
speech:finish
speech:start
speech:stop
update:check
update:download
update:get-state
update:install
```

## Ownership reminder

- Functional expectations for route behavior live primarily in `07-backend-http-sse-webhook-api.md`, `08-cloud-registry-conduit-mcp.md`, `09-security-privacy-data-migrations.md`, and `10-electron-packaging-ci-release.md`.
- Surface-specific user journeys live in `01` through `06` and `11`.
- Fresh command results live in `12-automated-suite-environments-and-evidence.md` and `14-execution-report.md`.

## Source-derived census

| Surface | Discovered | QA mapping | Execution state / limit |
|---|---:|---|---|
| Main renderer | `77` production TSX files | Docs `01`-`06`, cross-cut by doc `11` | Mixed automated and `Manual — executable` |
| Standalone sigil preview | `1` TSX, `2` buttons | `AX-VIS-*` | Manual visual proof |
| Main-renderer native/associated declarations | `596` across `63` files | File ledger below | Static declarations, not runtime rows: `439 button`, `59 input`, `10 select`, `11 textarea`, `10 a`, `12 form`, `31 label`, `19 summary` |
| Desktop navigation | `4` primary views, `5` store overlays, `6` System destinations, `9` navigation actions | Destination ledger below | Mixed evidence |
| Main harness HTTP | `136`: `123` public + `13` internal | `136/136` source shapes inventoried here and mapped across docs `01`-`09`; umbrella doc `07` | Static route mapping is complete; direct HTTP automation gaps remain explicit |
| Webhook sidecar | `3` | `API-OPS-*`, `WHK-*`, `SEC-*` | Automated ingress plus manual integration |
| Companion device allowlist | `47`: `45` allowlist + pair + health | `VM-CTRL-008` through `VM-CTRL-015` | `47/47` positive allow assertions; `POST /api/groups` now included |
| Companion loopback control plane | `9`, counting `/` and `/index.html` separately | `VM-CTRL-001` through `VM-CTRL-007` | Mixed evidence |
| Electron inbound IPC | `64` source call sites; `76` runtime registrations | `PKG-BRIDGE-*`, `PKG-NATIVE-*`, `WB-IPC-*`, `VM-*`, `SYS-*` | `74 handle` + `2 on`; `12` are compatibility aliases |
| Preload IPC | `81` call sites, `71` unique names | Electron/event ledger below | `62` requests + `10` events; `browser:state` belongs to both |
| Registry/Reach | `10` direct routes + `3` app-used delegated auth paths | `REG-*`, `RCH-*`, `DRF-*`, `OPS-*` | Generic `OPTIONS`, `/api/auth/*`, scheduled cleanup tracked separately |
| Conduit | `10` concrete routes | `CON-*`, `DRF-002`, `OPS-*` | Worker evidence required |
| MCP/proxy | `78` static definitions, `70` unique names | `MCP-*`, `WB-TOOL-*`, `WB-BHOST-*` | Dynamic upstream connector/Pi tools cannot be statically named |
| Package scripts | `83` across `5` manifests | Doc `12`; manifest ledger below | Root `63`, Companion `1`, docs `9`, Workers `5` each |
| CI/release workflows | `4` files, `11` jobs, `15` file/job labels | `PKG-CI-*`; doc `12`; exact block above | Static mapping; live hosted jobs remain manual/external evidence |
| Configured test files | `253` | Doc `12`; runner ledger below | Inventory only: `228` root Vitest + `8` Node + `3` Worker + `14` XCTest |
| iOS production UI | `38` App Swift + `1` Widget Swift; `53` App + `3` Widget views | `VM-IOS-001` through `VM-IOS-065` | `23/23` detected control-bearing App/Widget files are referenced; runtime device proof remains manual/external where stated |

## Reproducible method

```sh
find src -type f -name '*.tsx' | sort
rg -n 'path\s*===\s*"/api/|path\.match\(/\^\\/api|\.exec\(path\)|path\.startsWith\("/api/' server/index.ts
rg -n 'url\.pathname\s*===|url\.pathname\.match' server/webhook-ingress.ts
sed -n '/const ALLOWED/,/^];/p' companion/src/routes.ts
rg -n 'method ===|path ===|path\.match' companion/src/control.ts
rg -n --glob 'electron/*.{mjs,cjs,js}' 'ipcMain\.(handle|on|once)\(' electron
find server src companion scripts electron cloudflare -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs' -o -name '*.node-test.mjs' \) | sort
find ios/Tests -type f -name '*Tests.swift' | sort
rg -n '^\s*(?:@MainActor\s+)?func\s+test[A-Za-z0-9_]*\s*\(' ios/Tests -g '*.swift'
```

Route alternatives and method unions were expanded into semantic method/path shapes. The packaged static GET catch-all and generic 404/405 fallbacks are excluded. TSX controls were counted with the TypeScript AST using `{button,input,select,textarea,a,form,label,summary}` and excluding `src/sigil-preview.tsx`; `form` and `label` are included for submit/association tests, while `details` and `option` are excluded to avoid double-counting `summary` and `select`.

## Desktop destination ledger

| Source | Exact destinations/actions | Primary QA IDs | State |
|---|---|---|---|
| `AppState.activeView` | `chat`, `team-map`, `routines`, `skill-recorder` | `SH-ROUTE-*`, `WS-SHL-*`, `OPS-NAV-*`, `CAD-*`, `MTH-FLAG-*` | Specified; recorder feature-gated |
| Selected chat | operator -> `ChatView`; crew -> `GroupView` | `SH-ROUTE-001`, `SH-ROUTE-002`, `WS-*` | Mixed |
| Store overlays | `settingsOpen` -> `SettingsPanel`; `pluginsOpen` -> `PluginsPanel`; `computerOpen` -> `ComputerPanel`; `inspectorOpen` -> `InspectorPanel`; `appSettingsOpen` -> `SettingsModal` | `SYS-DOS-*`, `CAP-*`, `WB-PANEL-*`, `TRC-*`, `SYS-NAV-*` | Mixed |
| Store navigation actions | `select`, `showTeamMap`, `showRoutines`, `showSkillRecorder`, `toggleSettings`, `togglePlugins`, `toggleComputer`, `toggleInspector`, `toggleAppSettings` | Same owners as destinations | Reducer automation plus manual focus proof |
| System destinations | `general`/System, `connections`/Connections, `engines`/Engines, `companion`/Helmryth Mobile, `computer`/Workbench, `usage`/Spend ledger | `SYS-GEN-*`, `SYS-CON-*`, `SYS-ENG-*`, `SYS-MOB-*`, `SYS-WBK-*`, `SYS-USE-*` | Mixed |
| App-local/nested | Browser/Local VM workspaces; drawer; palette; no-engine; onboarding; updater; empty/connecting; Workbench `computer/android/browser`; Cadences `calendar/webhooks`; Capabilities `marketplace/connected`; library `explore/import/scout`; model `main/custom`; Trace `events/provider-raw` | Docs `01`, `03`, `04`, `05`, `06` owning IDs | Manual destination sweep still required |

## Desktop renderer file/control ledger

Counts are AST declarations. Every row is also bound to doc `11` for keyboard, focus, accessible name/state, reduced motion, responsive widths, contrast, visual identity, and performance.

| Source | Count | Primary QA IDs |
|---|---:|---|
| `App.tsx` | 1 | `SH-*`; `AX-*` |
| `ActivityRun.tsx` | 2 | `WS-MSG-*`; `ACT-FOLD-*` |
| `AgentSkillsPanel.tsx` | 15 | `MTH-API-001..005` |
| `AndroidDevicePanel.tsx` | 5 | `VM-AND-*`; `WB-PLAT-*` |
| `ApiKeys.tsx` | 14 | `SYS-CON-*`; `SEC-*` |
| `AttachmentPreview.tsx` | 3 | `WS-MSG-*`; `WS-CMP-*` |
| `BotPickerList.tsx` | 1 | `RS-*`; `WS-*` |
| `BotProfileAvatarCard.tsx` | 14 | `SYS-DOS-*` |
| `BrowserPanel.tsx` | 14 | `WB-BUI-*` |
| `BrowserWorkspace.tsx` | 2 | `WB-BUI-*`; `WB-BHOST-*` |
| `CallView.tsx` | 6 | `VM-VOICE-*` |
| `ChatFindBar.tsx` | 4 | `WS-SHL-*`; `AX-KEY-*` |
| `ChatMarkdown.tsx` | 5 | `WS-MSG-*` |
| `ChatView.tsx` | 30 | `WS-SHL/MSG/CMP/GAT/RUN-*` |
| `CloudBackendPicker.tsx` | 1 | `SYS-WBK-*`; `WB-*` |
| `CommandPalette.tsx` | 2 | `CP-*` |
| `CompanionSection.tsx` | 12 | `VM-MOB-*`; `SYS-MOB-*` |
| `Composer.tsx` | 16 | `WS-CMP-*` |
| `ComposerAttachments.tsx` | 4 | `WS-CMP-*` |
| `ComputerPanel.tsx` | 32 | `WB-PANEL-*` |
| `ConnectionDetail.tsx` | 2 | `CONN-DETAIL-*`; `VM-MOB-*` |
| `ConnectorCard.tsx` | 3 | `CAP-INLINE-*` |
| `EngineSetup.tsx` | 4 | `OB-ENG-*`; `SYS-ENG-*` |
| `EnginesSettings.tsx` | 8 | `SYS-ENG-*` |
| `GroupCallView.tsx` | 4 | `VM-VOICE-*` |
| `GroupView.tsx` | 38 | `WS-SHL/MSG/CMP/CRW/GAT/RUN-*` |
| `InspectorPanel.tsx` | 4 | `TRC-*` |
| `LinuxLocalControl.tsx` | 7 | `WB-HOST-*`; `WB-PLAT-*` |
| `LocalComputerAutoWarning.tsx` | 2 | `WB-GATE-*` |
| `LocalComputerSection.tsx` | 13 | `WB-SETUP-*` |
| `LocalScreenPreview.tsx` | 1 | `WB-HOST-*` |
| `LocalVmWorkspace.tsx` | 7 | `WB-SPLIT-*` |
| `MacLocalControl.tsx` | 4 | `WB-HOST-*` |
| `ManageMembersPanel.tsx` | 2 | `WS-CRW-*` |
| `ModelPicker.tsx` | 8 | `SYS-ENG-*`; `SYS-DOS-*` |
| `NoEngines.tsx` | 1 | `SH-LIFE-*`; `SYS-ENG-*` |
| `Onboarding.tsx` | 9 | `OB-*` |
| `OptionCard.tsx` | 6 | `WS-GAT-*` |
| `PendingApproval.tsx` | 5 | `WS-GAT-*` |
| `PhoneSetupFlow.tsx` | 18 | `OB-MOB-*`; `VM-MOB-*` |
| `PluginsPanel.tsx` | 16 | `CAP-*` |
| `Reactions.tsx` | 4 | `WS-MSG-*` |
| `RenameTitle.tsx` | 3 | `RS-*`; `WS-SHL-*` |
| `ReplyQuote.tsx` | 2 | `WS-MSG-*` |
| `RoomTurnTimeoutSettings.tsx` | 2 | `SYS-GEN-*`; `WS-CRW-*` |
| `RoutineRunCard.tsx` | 1 | `CAD-DETAIL-*` |
| `RoutinesPage.tsx` | 38 | `CAD-*`; `WHK-*` |
| `SearchResults.tsx` | 1 | `SR-*` |
| `SecretRequestCard.tsx` | 7 | `WS-GAT-*`; `SEC-*` |
| `SettingsModal.tsx` | 18 | `SYS-*` |
| `SettingsPanel.tsx` | 27 | `SYS-DOS-*` |
| `SettingsPrimitives.tsx` | 1 | `SYS-*`; `AX-*` |
| `Sidebar.tsx` | 45 | `RS-*`; `SH-ROUTE-*` |
| `SidebarPhoneButton.tsx` | 1 | `OB-MOB-*`; `VM-MOB-*` |
| `SkillRecorderPage.tsx` | 12 | `MTH-*` |
| `SpeakButton.tsx` | 1 | `VM-VOICE-*` |
| `TaskPicker.tsx` | 10 | `WS-RUN-*` |
| `TeamLibraryPanel.tsx` | 24 | `LIB-*`; `OPS-PKG-*` |
| `TeamMapPage.tsx` | 8 | `OPS-*` |
| `TranscriptionSettings.tsx` | 4 | `SYS-GEN-*`; `VM-VOICE-*` |
| `UpdateBanner.tsx` | 6 | `UP-*`; `PKG-BRIDGE-006` |
| `VoiceSettings.tsx` | 7 | `SYS-DOS-*`; `VM-VOICE-*` |
| `WebhooksPanel.tsx` | 29 | `WHK-*` |

The 14 zero-declaration main-renderer files remain mapped: `ApprovalCard` -> `WS-GAT-*`; `Avatar` -> `RS-*`/`AX-VIS-*`; `CursorMark` -> `WB-*`; `DesktopCapabilities` -> `SYS-X-*`/`PKG-BRIDGE-*`; `EngineGroupLabel` and `ProviderIcons` -> `SYS-ENG-*`; `HelmrythMark`, `HermesMark`, `OperatorSigil`, and `SkinPicker` -> identity/visual cases; `TurnPresence` -> `WS-STS-*`; `UsageSection` -> `SYS-USE-*`; `main` -> `SH-LIFE-*`; `state/store` -> reducer/API cases in docs `01`-`06`.

## Canonical harness route ledger

This is the source authority: `123` renderer-facing loopback routes, `13` comms-token internal routes, and `3` webhook-sidecar routes. Parameter names are semantic; they do not change the count.

### Public main server — 123

```text
GET /api/team-map
GET /api/routines
POST /api/routines
POST /api/routines/:routineId/run
PATCH /api/routines/:routineId
DELETE /api/routines/:routineId
POST /api/routine-runs/:runId/cancel
POST /api/routine-runs/:runId/seen
GET /api/webhooks
POST /api/webhooks
POST /api/webhooks/:webhookId/rotate
POST /api/webhooks/:webhookId/test
PATCH /api/webhooks/:webhookId
DELETE /api/webhooks/:webhookId
GET /api/events
GET /api/bots
GET /api/threads/:threadId/messages
GET /api/threads/:threadId/messages/:messageId/image
POST /api/attachments
GET /api/attachments/:name
GET /api/search
GET /api/threads/:threadId/export
POST /api/groups
POST /api/teams/export
GET /api/team-library/catalog
GET /api/team-library/teams/:teamSlug
POST /api/team-library/github
GET /api/teams/scout
GET /api/teams/scout/directory
GET /api/teams/imports
POST /api/teams/import
POST /api/teams/imports/:transactionId/undo
PATCH /api/groups/:groupId/setup
POST /api/groups/:groupId/tasks
POST /api/groups/:groupId/tasks/:threadId
PATCH /api/groups/:groupId/tasks/:threadId
DELETE /api/groups/:groupId/tasks/:threadId
PATCH /api/groups/:groupId
POST /api/groups/:groupId/read
DELETE /api/groups/:groupId
POST /api/groups/:groupId/messages
POST /api/groups/:groupId/interrupt
POST /api/threads/:threadId/messages/:messageId/reactions
POST /api/bots
POST /api/bots/:botId/avatar/generate
PATCH /api/bots/:botId/profile
POST /api/bots/:botId/read
POST /api/bots/:botId/always-allow
PATCH /api/bots/:botId
POST /api/local-computer/interrupt
DELETE /api/bots/:botId
GET /api/bots/:botId/skills
POST /api/bots/:botId/skills
GET /api/bots/:botId/skills/:skillSlug
PATCH /api/bots/:botId/skills/:skillSlug
DELETE /api/bots/:botId/skills/:skillSlug
GET /api/section-context
PUT /api/section-context
GET /api/bots/:botId/memory
PUT /api/bots/:botId/memory
GET /api/bots/:botId/memory/topics/:name
GET /api/bots/:botId/checkpoints
POST /api/bots/:botId/checkpoints/restore
PATCH /api/bots/:botId/cards/:messageId
POST /api/bots/:botId/messages
DELETE /api/bots/:botId/queue/:queueId
POST /api/bots/:botId/messages/:messageId/edit
POST /api/bots/:botId/active-branch
POST /api/bots/:botId/respond
POST /api/threads/:threadId/respond
POST /api/bots/:botId/interrupt
POST /api/bots/:botId/tasks
POST /api/bots/:botId/tasks/:threadId
PATCH /api/bots/:botId/tasks/:threadId
DELETE /api/bots/:botId/tasks/:threadId
GET /api/local-computer
POST /api/local-computer/pull
POST /api/local-computer/run
POST /api/local-computer/start
POST /api/local-computer/stop
POST /api/local-computer/remove
POST /api/local-computer/screenshot
GET /api/bots/:botId/local-computer
POST /api/bots/:botId/local-computer/run
POST /api/bots/:botId/local-computer/stop
POST /api/bots/:botId/local-computer/remove
POST /api/bots/:botId/local-computer/screenshot
GET /api/health
GET /api/threads/:threadId/events
GET /api/decisions
GET /api/instances
PATCH /api/instances/:instanceId
GET /api/cli-candidates
POST /api/cli-test
GET /api/config
PUT /api/config
PATCH /api/config
POST /api/tts/prepare
GET /api/tts/voices
POST /api/tts/speak
GET /api/connectors/catalog
GET /api/connectors/connected
GET /api/connectors
POST /api/connectors/:slug/authorize
DELETE /api/connectors/:slug/accounts/:accountId
DELETE /api/connectors/:slug
POST /api/bots/:botId/secret-cards/:messageId/provided
POST /api/bots/:botId/secret-cards/:messageId/resume
POST /api/bots/:botId/secret-cards/:messageId/dismiss
POST /api/bots/:botId/connector-cards/:messageId/authorize
GET /api/bots/:botId/connector-cards/:messageId/status
POST /api/bots/:botId/connector-cards/:messageId/resume
POST /api/bots/:botId/connector-cards/:messageId/dismiss
GET /api/bots/:botId/computer
GET /api/bots/:botId/computer/control
POST /api/bots/:botId/computer/control
POST /api/bots/:botId/computer/viewer-close
POST /api/bots/:botId/computer/provision
POST /api/bots/:botId/computer/join
POST /api/bots/:botId/computer/sleep
POST /api/bots/:botId/computer/exec
POST /api/bots/:botId/computer/screenshot
POST /api/bots/:botId/computer/remove
```

Distribution: `GET 35`, `POST 61`, `PATCH 12`, `DELETE 10`, `PUT 3`.

### Internal main server — 13

```text
GET /api/internal/agents
GET /api/internal/routines
POST /api/internal/routine-requests
POST /api/internal/ask-bot
GET /api/internal/delegations/:taskId
POST /api/internal/delegate-bot
POST /api/internal/create-bot
POST /api/internal/request-credential
POST /api/internal/connectors/mcp
GET /api/internal/computer-control
POST /api/internal/computer-control
DELETE /api/internal/computer-control
POST /api/internal/connectors/request
```

### Webhook sidecar — 3

```text
GET /health
POST /hooks/:endpointId
POST /hooks/:endpointId/:secret
```

### Harness route-family ownership

| Family | Primary QA mappings | State |
|---|---|---|
| Health/events/config/instances/CLI/decisions/search/TTS | `API-META-*`, `SYS-API-*`, `SYS-ENG-*`, `TRC-*`, `SEC-*` | Mixed; exact method corrections remain in gap register |
| Operations/Cadences/receipts/Webhooks | `OPS-*`, `CAD-*`, `WHK-*`, `API-OPS-*` | Mixed; Webhook test lacks direct route proof |
| Threads/attachments/reactions/export/events | `WS-API-*`, `API-ART-*`, `WS-MSG-*`, `TRC-*` | Reactions lack direct HTTP proof |
| Operators/runs/profiles/messages/queue/cards/memory/skills/checkpoints | `RS-*`, `WS-API-*`, `WS-RUN-*`, `WS-GAT-*`, `SYS-DOS-*`, `MTH-API-*`, `CPK-*` | Mixed; direct gaps below |
| Crews and crew runs | `WS-API-*`, `WS-CRW-*`, `WS-RUN-*` | Mixed; preserve exact PATCH/DELETE methods |
| Team library/scout/import/export | `LIB-*`, `OPS-PKG-*`, `API-LIB-*` | Automated service plus manual artifact proof |
| Shared/per-operator Local VM and cloud Workbench | `WB-API-*`, `WB-SETUP-*`, `WB-PANEL-*`, `WB-GATE-*`, `SEC-*` | Several routes rely on lower-layer tests |
| Connected apps and inline connector/secret cards | `CAP-API-*`, `CAP-ACCT-*`, `CAP-INLINE-*`, `WS-GAT-*`, `SEC-*` | Connector-card HTTP lifecycle gaps remain |
| Internal agent/connector/computer control | `API-INT-*`, `WS-API-*`, `MCP-*`, `WB-TOOL-*` | Connector request and exact computer-control proof needed |
| Webhook ingress | `API-OPS-*`, `WHK-ING-*`, `WHK-SEC-*`, `SEC-*` | Focused automation plus manual E2E |

## Companion routes

### Effective device-facing allowlist — 47

The default is deny. The `45` entries in `ALLOWED` plus pre-authentication pair and health exceptions produce these exact shapes:

```text
POST /api/pair
GET /api/health
GET /api/config
GET /api/events
GET /api/instances
GET /api/companion/endpoints
GET /api/bots
POST /api/bots
POST /api/bots/:botId/messages
POST /api/bots/:botId/interrupt
POST /api/bots/:botId/read
POST /api/bots/:botId/always-allow
POST /api/bots/:botId/messages/:messageId/edit
POST /api/bots/:botId/active-branch
POST /api/bots/:botId/tasks
POST /api/bots/:botId/tasks/:threadId
PATCH /api/bots/:botId/tasks/:threadId
DELETE /api/bots/:botId/tasks/:threadId
PATCH /api/bots/:botId/profile
POST /api/bots/:botId/avatar/generate
POST /api/bots/:botId/computer/join
POST /api/groups
POST /api/groups/:groupId/messages
POST /api/groups/:groupId/read
POST /api/groups/:groupId/tasks
POST /api/groups/:groupId/tasks/:threadId
PATCH /api/groups/:groupId/tasks/:threadId
DELETE /api/groups/:groupId/tasks/:threadId
GET /api/threads/:threadId/messages
GET /api/threads/:threadId/messages/:messageId/image
POST /api/threads/:threadId/messages/:messageId/reactions
GET /api/threads/:threadId/export
POST /api/threads/:threadId/respond
GET /api/search
POST /api/attachments
GET /api/attachments/:filename
GET /api/tts/voices
POST /api/tts/speak
GET /api/routines
POST /api/routines
PATCH /api/routines/:routineId
DELETE /api/routines/:routineId
POST /api/routines/:routineId/run
GET /api/connectors/catalog
GET /api/connectors/connected
GET /api/connectors
POST /api/connectors/:slug/authorize
```

Distribution: `GET 16`, `POST 24`, `PATCH 4`, `DELETE 3`. Ownership is `VM-CTRL-008` pair, `VM-CTRL-009` health, `VM-CTRL-010` method-exact allowlist/default deny, `VM-CTRL-011` authentication, `VM-CTRL-012` Origin, `VM-CTRL-013` SSE, `VM-CTRL-014` endpoint metadata, and `VM-CTRL-015` cloud viewer capability. `POST /api/groups` is allowed and used by the iOS client and is now included in the positive allow enumeration in `companion/test/routes.test.ts`.

### Loopback control plane — 9

```text
GET /
GET /index.html
GET /state
POST /pairing
DELETE /pairing
PUT /hosted-endpoint
POST /devices/:deviceId/cloud-desktop
DELETE /devices/:deviceId/cloud-desktop
DELETE /devices/:deviceId
```

These map to `VM-CTRL-001` through `VM-CTRL-007`. The device allowlist does not include this control plane. `/api/companion/endpoints` terminates in the sidecar; cloud join also requires the per-device capability after allowlist admission. Config writes, Local VM, Webhook management, connector deletion, team import/export, and internal routes remain intentionally denied.

## Electron and preload channel ledger

| Inventory | Count | Meaning |
|---|---:|---|
| `ipcMain` source registration call sites | `64` | `51` main + `6` CUA + `4` updater + `3` Android |
| Literal source registrations | `52` | `50 handle` + `2 on` |
| Dynamic prefix registration call sites | `12` | Seven Reach and five Registry operations |
| Runtime inbound registrations | `76` | `74 handle` + `2 on`; `64` canonical + `12` deprecated aliases |
| Preload `ipcRenderer` call sites | `81` | Multiline-safe scan including listener cleanup |
| Preload unique names | `71` | `62` invoke/send/sendSync request names + `10` subscribed events; `browser:state` overlaps |

Dynamic runtime families are exact:

| Canonical prefix | Deprecated alias | Operations | Primary QA mapping |
|---|---|---|---|
| `reach` | `companion` | `state`, `start`, `stop`, `keep-awake`, `pairing`, `cloud-desktop`, `revoke` | `PKG-BRIDGE-008`; `VM-MOB-*`; `SYS-MOB-*` |
| `registry` | `companion-account` | `state`, `request-code`, `verify-code`, `retry`, `sign-out` | `PKG-BRIDGE-008`; `VM-MOB-*`; `REG-*` |

Literal registration families map as follows:

| Family | Count | Primary QA mapping |
|---|---:|---|
| Android | 3 | `PKG-NATIVE-005`; `VM-AND-*` |
| AssemblyAI | 3 | `PKG-BRIDGE-009`; `SYS-DOS-*`; `VM-VOICE-*` |
| Browser | 8 | `PKG-NATIVE-001`; `WB-IPC-*`; `WB-BHOST-*` |
| Credential | 1 | `PKG-BRIDGE-009`; `SEC-*` |
| CUA | 6 | `PKG-NATIVE-004`; `WB-HOST-*`; `WB-PLAT-*` |
| Desktop viewer | 3 | `PKG-NATIVE-002`; `WB-IPC-*` |
| Desktop workspace | 4 | `PKG-NATIVE-003`; `WB-SPLIT-*`; `WB-IPC-*` |
| Desktop utilities | 7 | `PKG-BRIDGE-002` through `PKG-BRIDGE-004`; `SYS-*`; `SH-*` |
| Engine terminal | 1 | `PKG-BRIDGE-002`; `OB-ENG-*`; `SYS-ENG-*` |
| Permissions | 3 | `PKG-BRIDGE-004`; `VM-VOICE-*`; `WB-HOST-*` |
| Screen | 2 | `PKG-BRIDGE-004`; `WB-HOST-*` |
| Skill recorder | 4 | `PKG-BRIDGE-005`; `MTH-*` |
| Speech | 3 | `PKG-BRIDGE-005`; `VM-VOICE-*` |
| Updater | 4 | `PKG-BRIDGE-006`; `UP-*`; `PKG-NATIVE-006` |

The exact preload-subscribed main-to-renderer events are:

```text
browser:state
desktop-viewer:state
desktop-workspace:state
desktop:capabilities-changed
package:install
skill-recorder:end
skill-recorder:event
speech:end
speech:transcript
update:state
```

`package:install` is an outbound event, not an `ipcMain` handler. `browser:state` is both request/response and event. Preload exposes `62` request channel names and omits only internal `cua:connection` and `cua:permissions` from the canonical inbound set. Behavior maps to `PKG-BRIDGE-001` through `PKG-BRIDGE-009`, `PKG-NATIVE-*`, and owning domain cases; exact event-string coverage was absent before this ledger and remains a checker-generation gap.

## Registry, Reach, and Conduit routes

### Registry/Reach direct branches — 10

```text
GET /healthz
GET /v1/account
GET /v1/nodes
POST /v1/nodes
GET /v1/nodes/self
POST /v1/nodes/:nodeId/credentials/rotate
DELETE /v1/nodes/:nodeId
GET /v1/nodes/self/reach
POST /v1/nodes/self/reach
DELETE /v1/nodes/self/reach
```

The first seven map to `REG-001` through `REG-012`; Reach maps to `RCH-001` through `RCH-008`; client compatibility maps to `DRF-001`, `DRF-003` through `DRF-005`; operations to `OPS-001`, `OPS-003`, `OPS-005`; suites to `SUITE-009` through `SUITE-011`.

The Worker additionally has generic `OPTIONS`, generic `/api/auth/*` delegation, and scheduled Reach cleanup. The three application-used delegated auth shapes are:

```text
POST /api/auth/email-otp/send-verification-otp
POST /api/auth/sign-in/email-otp
POST /api/auth/sign-out
```

They are application-facing routes but not independent direct path branches in the Worker switch. Therefore “10 direct” and “13 application-used” are both valid only with this distinction.

### Conduit — 10

```text
GET /healthz
POST /v1/nodes
GET /v1/self
POST /v1/mcp
GET /v1/capabilities/catalog
GET /v1/capabilities/active
GET /v1/capabilities
POST /v1/capabilities/:slug/authorize
DELETE /v1/capabilities/:slug
DELETE /v1/capabilities/:slug/accounts/:accountId
```

These map to `CON-001` through `CON-011`, `DRF-002`, `OPS-002`, `OPS-003`, `OPS-005`, and `SUITE-012` through `SUITE-014`. Desktop clients now use the current Account/Node/Reach paths and `hry_<64 hex>` Conduit token class; stale older-path wording is a documentation regression to remove, not a live source drift.

## MCP and proxy tool ledger

| Static surface | Count | Exact tool names | Primary QA mapping |
|---|---:|---|---|
| CLI MCP | 19 | `get_system_health`, `list_operators`, `get_operator_messages`, `send_operator_message`, `create_operator`, `update_operator_profile`, `list_crews`, `get_crew_messages`, `send_crew_message`, `create_crew`, `update_crew`, `create_run`, `switch_run`, `rename_run`, `search_messages`, `wait_for_conversation`, `set_operator_model`, `list_available_models`, `interrupt_conversation` | `MCP-001` |
| Computer proxy | 16 | `screenshot`, `browser_state`, `browser_snapshot`, `browser_click`, `browser_fill`, `wait_for_navigation`, `observation_metrics`, `computer_status`, `computer_request_help`, `click`, `type_text`, `press_key`, `scroll`, `computer_batch`, `computer_exec`, `open_url` | `MCP-002`; `WB-TOOL-001` through `WB-TOOL-007` |
| Permission proxy | 2 | `approve`, `ask_user` | `MCP-007` |
| Agents proxy | 10 | `list_operators`, `ask_operator`, `delegate_operator`, `check_delegation`, `wait_delegation`, `create_operator`, `request_credential`, `list_cadences`, `propose_cadence`, `propose_cadence_action` | `MCP-008`; `API-INT-*` |
| dweb proxy | 4 | `dweb_status`, `dweb_repo_status`, `dweb_opencode_models`, `dweb_opencode_run` | `MCP-009` |
| Phone proxy | 10 | `status`, `read_screen`, `screenshot`, `list_apps`, `open_app`, `tap_text`, `tap`, `swipe`, `type_text`, `press` | `MCP-010`; `VM-AND-*` |
| Built-in browser proxy | 17 | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_wait_for`, `browser_read`, `browser_back`, `browser_forward`, `browser_request_takeover`, `browser_state`, `browser_screenshot` | `WB-TOOL-008`, `WB-TOOL-009`, `WB-BHOST-002` through `WB-BHOST-017` |

Total: `78` definitions and `70` unique names because overlaps are intentional across servers. `connector-proxy.ts` and `pi-mcp-extension.ts` expose dynamic upstream inventories; `container-mcp.ts`, `vps-container-mcp.ts`, and `mcp-bridge.ts` are transport/hold/liveness bridges with no fixed local tool list. Their ten packaged proxy entries are `computer`, `permission`, `containerMcp`, `vpsContainerMcp`, `agents`, `dweb`, `connectors`, `phone`, `browser`, and `piMcpExtension`; packaging resolution is owned by `MCP-003` through `MCP-006`, `PKG-ART-*`, and `SUITE-005`.

## Package script and automated-source ledger

The root block earlier in this file lists all `63` root script names. The remaining `20` scripts are:

| Manifest | Count | Exact names | QA owner |
|---|---:|---|---|
| `companion/package.json` | 1 | `start` | `VM-CTRL-*`; doc `12` |
| `apps/docs/package.json` | 9 | `assets:sync`, `prebuild`, `predev`, `build`, `dev`, `start`, `types:check`, `lint`, `preview` | `SUITE-008`; docs/release evidence |
| `cloudflare/composio-broker/package.json` | 8 | `check`, `deploy:production`, `dry-run`, `preflight`, `preflight:test`, `test`, `types`, `types:check` | `SUITE-012` through `SUITE-014` plus protected Conduit deploy preflight |
| `cloudflare/control-plane/package.json` | 8 | `check`, `deploy:production`, `dry-run`, `preflight`, `preflight:test`, `test`, `types`, `types:check` | `SUITE-009` through `SUITE-011` |

Total package scripts are therefore `68 + 1 + 9 + 8 + 8 = 94`. The additional six entries are `registry:preflight`, `registry:preflight:test`, `registry:deploy`, and the Control Plane worker's `deploy:production`, `preflight`, and `preflight:test`.

The checker consumes the exact manifest-to-script mapping below. A generic script name documented under the wrong package does not satisfy the gate.

<!-- qa-package-script-ledger:start -->
```json
{
  "package.json": [
    "bench:observation",
    "build",
    "build:android-tools",
    "build:browser-snapshot",
    "build:cloudflared",
    "build:companion",
    "build:cua",
    "build:cua:linux",
    "build:cua:linux:offline",
    "build:icons",
    "build:recorder",
    "build:server",
    "build:speech",
    "build:updater",
    "check:brand",
    "check:contrast",
    "check:electron",
    "check:packaged",
    "check:qa-docs",
    "clean",
    "companion",
    "conduit:check",
    "conduit:deploy",
    "conduit:dry-run",
    "conduit:preflight",
    "conduit:preflight:test",
    "conduit:test",
    "conduit:types",
    "dev",
    "dev:desktop",
    "dev:server",
    "docs:build",
    "docs:dev",
    "docs:preview",
    "lint",
    "mcp",
    "package",
    "package:linux",
    "package:linux:dir",
    "package:linux:offline",
    "package:mac",
    "package:prepare",
    "package:release:linux",
    "package:release:linux:offline",
    "package:release:mac",
    "package:release:win",
    "package:win",
    "preview",
    "registry:check",
    "registry:dry-run",
    "registry:preflight",
    "registry:preflight:test",
    "registry:deploy",
    "registry:test",
    "registry:types",
    "release:config:check",
    "smoke:cua-x11-input",
    "smoke:linux-package",
    "test",
    "test:cua",
    "test:cua-container",
    "test:desktop-viewer",
    "test:package-link",
    "test:packaged-server",
    "test:save-file",
    "test:server-boot-probe",
    "test:updater",
    "test:watch",
    "typecheck"
  ],
  "companion/package.json": [
    "start"
  ],
  "apps/docs/package.json": [
    "assets:sync",
    "build",
    "dev",
    "lint",
    "prebuild",
    "predev",
    "preview",
    "start",
    "types:check"
  ],
  "cloudflare/composio-broker/package.json": [
    "check",
    "deploy:production",
    "dry-run",
    "preflight",
    "preflight:test",
    "test",
    "types",
    "types:check"
  ],
  "cloudflare/control-plane/package.json": [
    "check",
    "deploy:production",
    "dry-run",
    "preflight",
    "preflight:test",
    "test",
    "types",
    "types:check"
  ]
}
```
<!-- qa-package-script-ledger:end -->

The workflow inventory is `5` YAML files and `12` jobs: `ci.yml` has `test`, `registry`, `package-linux`, `ios`; `package-linux.yml` and `package-win.yml` each have `package`; `release-ios.yml` has `archive` (`release-ios:archive`); `release.yml` has `prepare`, `mac`, `windows`, `linux`, `assemble`. Together with the five filenames, the checker enforces `17` labels. Blank lines between jobs must not terminate the parser.

Configured runnable source inventory:

| Runner | Files | Source split | QA mapping / state |
|---|---:|---|---|
| Root Vitest | 271 | `129 server`, `85 src`, `13 companion`, `29 electron`, `15 scripts` | `SUITE-005`; fresh pass belongs in doc `14` |
| Node `--test` | 8 | desktop viewer, desktop workspace, package link, save file, server boot probe, single instance, update channel, updater coordinator | `SUITE-005`, `SUITE-006`; package/native cases |
| Worker Vitest | 3 | `1` Conduit + `2` Registry/Reach | `SUITE-009` through `SUITE-014` |
| XCTest | 14 | `188` `test*` methods | `SUITE-015`, `SUITE-016`; source inventory only when XCTest is unavailable |
| **Total** | **296** | `271 + 8 + 3 + 14` | Inventory is not execution evidence |

The root Vitest count intentionally excludes `.node-test.mjs`. Worker suites use their own configs. XCTest method count does not imply a pass on a host without full Xcode/XCTest.

## iOS UI ledger

Production contains `38` files under `ios/App`, `1` Widget Swift file, `53` direct App `View` structs, and `3` Widget `View` structs. Static App call sites are:

| Control | Count |
|---|---:|
| `Button` | 102 |
| `GlassButton` | 4 |
| `NavigationLink` | 7 |
| `TextField` | 16 |
| `Toggle` | 2 |
| `Picker` | 5 |
| `PhotosPicker` | 1 |
| `DatePicker` | 2 |
| `DisclosureGroup` | 4 |

The root router has six states: Welcome, Pairing, Unpaired home, Notification onboarding, Chats, and Revoked/recovery. Visible destinations/sheets add Pairing scanner, Chat, Settings, Updates, New crew, Run manager, Operator profile, Workbench preview, live cloud Workbench browser, Connection & Security, Runs & Cadences, Cadence editor, Capabilities, and system share sheet. These map to `VM-IOS-001` through `VM-IOS-065`, with route/auth boundaries in `VM-CTRL-*`.

| Control-bearing source group | Static actions | Current mapping assessment |
|---|---|---|
| `AgentProfileView.swift` | photo/crop/remove/generate; name/title/description; notifications/voice/preview/speak/save | `VM-IOS-044` through `VM-IOS-047` |
| Four `Cards/*.swift` views | expansion/copy/diff/table/receipt actions | `VM-IOS-061` through `VM-IOS-064` |
| `ChatListView.swift`, `CompanionApp.swift`, `Island.swift` | search/clear/cancel; new operator/crew; updates/settings/refresh; route/recovery actions | `VM-IOS-021` through `VM-IOS-028`, `VM-IOS-059` |
| Composer HUD/chips | command and predictive-action selection | `VM-IOS-038` through `VM-IOS-040` |
| `ConnectedAppsView.swift` | search/refresh/connect/add-account/alias | `VM-IOS-053`, `VM-IOS-054` |
| `NewGroupSheet.swift` | member toggles/create/cancel | `VM-IOS-043` |
| `TaskManagerView.swift` | switch/new/rename/delete run | `VM-IOS-048` |
| `TasksRoutinesView.swift` | pause/resume/run/edit/delete/new; days/date/picker/save | `VM-IOS-049` through `VM-IOS-052` |
| Core pairing/chat/settings/computer/onboarding/update views | pairing, send, interrupt, approvals, cloud viewer, connection security, notifications | `VM-IOS-001` through `VM-IOS-020`, plus `VM-IOS-029` through `VM-IOS-037` and `VM-IOS-055` through `VM-IOS-058` |

The current source-reference audit finds `23/23` detected control-bearing App/Widget files named in doc `06`; that static mapping gap is closed. Physical-device permissions, notification delivery, Widgets/Live Activities, camera/microphone, backgrounding, real pairing, and App Store signing remain `Manual — executable` or `Blocked — external prerequisite` exactly where their cases state.

## Explicit residual gaps and closed findings

| ID | Status | Finding | Required closure |
|---|---|---|---|
| `TRCOV-GAP-001` | Open | Exact route-string scans locate no direct HTTP assertion for reactions, always-allow, connector-card lifecycle, and several viewer-close/provision/join routes. Webhook create/list/rotate/delete are exercised, but `/api/webhooks/:id/test` lacks a direct request assertion. | Add method/path/status/body/persistence/event tests. Lower-level manager/backend tests do not count as route-level proof. |
| `TRCOV-CLOSED-008` | Closed | `POST /api/groups` belongs to the 47-shape Companion allowlist and is called by iOS. | The positive allowlist enumeration test now includes the exact call and retains wrong-method and default-deny assertions. |
| `TRCOV-CLOSED-005` | Closed | Doc `08` previously said `11` direct Registry method/path pairs. | It now states `10` direct routes plus `3` Better Auth routes and excludes generic `OPTIONS`/scheduled cleanup from that direct count. |
| `TRCOV-CLOSED-001` | Closed | The old route checker had 119 normalized main entries, omitted 19 source routes, and invented 4. | Checker now inventories all 136 main +3 sidecar +23 Worker/app-auth registrations: 162 registrations /160 unique strings. |
| `TRCOV-CLOSED-002` | Closed | Five exact preload event strings were previously absent from QA Markdown and outbound events were mixed with inbound handlers. | Ten events are now separated and checker-enforced; inbound runtime count remains 76. |
| `TRCOV-CLOSED-003` | Closed | Fifteen iOS files and many actions were only broadly mapped. | Doc `06` now has `VM-IOS-001` through `VM-IOS-065`; `23/23` detected control-bearing App/Widget files are referenced. |
| `TRCOV-CLOSED-004` | Closed | Desktop Registry/Conduit clients used retired paths/token shapes. | Current clients use Account/Node/Reach paths and `hry_` tokens; docs `04` and `08` retain resolved regression cases. |
| `TRCOV-CLOSED-006` | Closed | URL `.pathname` decoding and lexical main-module comparison could prevent the checker from running through paths containing spaces or symlinks. | Repository roots now use `fileURLToPath`; main-module detection compares decoded real paths. A CLI regression test executes through a spaced symlink with `--preserve-symlinks-main` and parses the emitted JSON. |
| `TRCOV-CLOSED-007` | Closed | Generic names such as `build`, `dev`, and `test` could satisfy package-script coverage even when documented under the wrong manifest. | The JSON ledger above binds every one of 94 scripts to its exact manifest; the checker rejects missing and unexpected manifest/script pairs, with a focused misattribution regression test. |

## Completion assertions

- **Proven static parity:** `78/78` main-renderer TSX files mapped; `63/63` control-bearing main-renderer files mapped; `596` declarations counted; `136/136` main harness routes inventoried; `3/3` webhook routes; `47/47` Companion device shapes; `9/9` Companion control-plane shapes; `76/76` runtime inbound IPC channels; `10/10` preload event topics; `10/10` direct Registry/Reach routes plus `3/3` app-used delegated auth paths; `10/10` Conduit routes; `78/78` static MCP/proxy definitions; `94/94` package scripts; `5/5` workflow files and `12/12` jobs; `296` configured test files inventoried; `23/23` detected iOS control-bearing sources referenced.
- **Not claimed as fully executed:** all 596 desktop declarations across runtime states and viewports; every iOS action on a signed physical device; signed installers and native permissions on every OS; real OAuth, Box, VPS, Registry/Reach, Conduit, Cloudflare, email, and release-repository flows.
- **Release rule:** every P0/P1 remains passing, manually evidenced, or explicitly `Blocked — external prerequisite`. Static mapping never upgrades a blocked/manual case to passing.
