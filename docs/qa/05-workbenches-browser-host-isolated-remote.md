# Helmryth Workbenches QA plan

This chapter is the executable acceptance contract for every Helmryth Workbench surface: panel shell, execution-surface selection, Host Workbench, Isolated Workbench, managed Box Remote Workbench, self-hosted VPS Remote Workbench, Browser Workbench, live viewer, Split Workbench, preview, control leases, and the Workbench-facing Cadence controls. It follows [the QA case contract](./TEST-CASE-TEMPLATE.md). A green unit suite alone does not complete a manual or end-to-end case.

## Completion definition

The lane is release-ready only when all P0 and P1 cases are `Automated — passing` or have retained manual evidence from every applicable platform. A platform-dependent case may be `Blocked — external prerequisite` only when the evidence names the missing runtime, account, hardware, permission, or host. No test may use production Box tokens, production SSH aliases, real credentials, or a user’s existing `~/.helmryth` directory.

Required retained artifacts:

- one JSON/JUnit report containing every automated mapping named here;
- Electron screenshots at 390, 768, and 1440 CSS pixels for the panel, Browser Workbench, Split Workbench, each Gate, and each terminal error;
- API request/response captures with authorization, viewer query values, Box tokens, browser-host bearer tokens, SSH material, and profile data redacted;
- Electron main/renderer console logs, server logs, browser-host logs, and container/VPS command transcripts with secrets redacted;
- accessibility tree and keyboard-focus recordings for every dialog and native-view handoff;
- Docker or Podman inspect JSON, image digest, viewer bind, mount, cap, resource, lease, and idle-timer evidence for isolated/VPS acceptance.

## Source-of-truth inventory

The cases were derived from these implementation boundaries, not from product copy alone:

- UI: `src/components/ComputerPanel.tsx`, `src/components/BrowserPanel.tsx`, `src/components/BrowserWorkspace.tsx`, `src/components/LocalVmWorkspace.tsx`, `src/components/LocalScreenPreview.tsx`, `src/components/LocalComputerSection.tsx`, `src/components/LocalComputerAutoWarning.tsx`, `src/components/MacLocalControl.tsx`, `src/components/LinuxLocalControl.tsx`, and `src/components/DesktopCapabilities.tsx`.
- Renderer contracts: `src/lib/desktop.ts`, `src/lib/local-computer.ts`, `src/lib/local-vm-workspace.ts`, and `src/lib/vps-computer.ts`.
- Native contracts: `electron/browser-host.cjs`, `electron/browser-surface.cjs`, `electron/browser-snapshot.cjs`, `electron/desktop-viewer.cjs`, `electron/desktop-workspace.cjs`, `electron/cua.mjs`, `electron/cua-linux*.cjs`, `electron/main.mjs`, and `electron/preload.cjs`.
- Server contracts: `server/index.ts`, `server/computer-control.ts`, `server/computer-observation.ts`, `server/computer-proxy.ts`, `server/container-computer.ts`, `server/local-computer.ts`, `server/local-vm-idle.ts`, `server/local-vm-lease.ts`, `server/remote-computer.ts`, `server/vps-computer.ts`, `server/vps-container-mcp.ts`, `server/browser-connection.ts`, `server/box.ts`, and `server/drivers/browser-proxy.ts`.

Inventory count in this chapter: **213 defined cases** comprising **25 app HTTP contracts, 17 browser-host HTTP contracts, 27 native IPC/event contracts, 107 rendered control/state cases, 10 platform/prerequisite cases, 12 operator-tool cases, 8 expanded high-risk scenarios, and 7 cross-cutting interaction cases**. Several cases exercise more than one implementation boundary; the route ledgers below are the canonical one-to-one route coverage.

## Safe fixtures and environments

| Fixture | Exact setup | Reset and proof |
|---|---|---|
| `WB-DATA-CLEAN` | `HELMRYTH_DATA_DIR` points to a new mode-0700 temporary directory; deterministic operators Rivet and Cairn use fake providers. | Stop children, close viewers/tunnels, assert no process or port remains, archive redacted logs, then delete only the resolved temporary directory. |
| `WB-BOX-FAKE` | Local fake ASCII/Box API supports missing, starting, ready, archived, error, rate-limit, auth, billing, truncated-image, and delayed responses. Token is unique test data. | Assert `noEnv: true`, created-on-failure box cleanup, Chrome quiesce before sleep, no test token in config response/log/transcript. |
| `WB-VPS-FAKE` | Disposable Linux SSH target with validated alias `qa-vps`, fake or nested Docker, pinned image fixtures, no production keys. | Close loopback SSH forward, remove only managed `com.helmryth.vps` containers, retain inspect and argv evidence. |
| `WB-VM-SHARED` | Supported Docker or rootless Podman, prepared pinned image, shared allocation, loopback noVNC, durable temp workspace. | Stop/remove managed shared container; prove durable directory behavior separately from disposable desktop state. |
| `WB-VM-DEDICATED` | Dedicated allocation, max 2, Rivet and Cairn containers, distinct workspace paths, ports, labels, and control leases. | Release both leases, close native views, remove only both managed target containers, verify cross-target isolation. |
| `WB-HOST-MAC` | Supported macOS build with separate snapshots for neither, Accessibility-only, Screen Recording-only, and both permissions. | Revoke only on a dedicated QA account when possible; record relaunch state and never automate System Settings clicks that bypass consent. |
| `WB-HOST-XORG` | Ubuntu 24.04 GNOME/Xorg, certified private Workbench Driver, opt-in initially false. | Interrupt active host runs before disable; stop owned daemon; preserve opt-in only where the case requires restart proof. |
| `WB-HOST-WAYLAND` | Ubuntu 24.04 GNOME/Wayland, portal screen selection available, seat-control gate intentionally blocked. | End every MediaStream track and prove Host control stays disabled. |
| `WB-WINDOWS` | Supported Windows desktop build plus Podman Desktop; Docker may be installed concurrently to test runtime choice. | Stop/remove QA containers and ensure no firewall/public viewer rule was created. |
| `WB-BROWSER-SITE` | Local HTTP/HTTPS fixture site with history, inputs, select/multi-select, drag target, dialog, download, popup, slow route, sign-in wall, CAPTCHA copy, large text, and URL secrets. | Clear named and temporary profile partitions; verify private operator partitions remain isolated. |

All mutation requests use `Content-Type: application/json`; form-shaped POSTs are deliberately negative tests. Record the boot-token boundary separately from payload authorization. Test clocks must be controllable for the 5-second setup poll, 3/4/30-second preview cadence, 8-hour idle stop, control lease expiry, 30-second browser wait ceiling, and takeover timeout.

## Platform and prerequisite matrix

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-PLAT-001 | macOS Host Workbench | Capability discovery | `WB-HOST-MAC`, packaged and development builds | Load before and after both grants | Host remains selectable before grants; capability becomes available only with required driver/permissions; direct screen frame is app-owned | Denied/stale permission never reports ready; returning from Settings triggers one retry; relaunch copy appears when required | `electron/capabilities.test.mjs`, `src/lib/local-computer.test.ts`, screenshot/capability JSON | P0 |
| WB-PLAT-002 | Windows Host Workbench | Execution surface: Host | `WB-WINDOWS` | Open operator Workbench | Host is disabled with an exact unavailable reason unless a certified Windows descriptor is present; Remote/Isolated/Off remain usable | Forged, stale, malformed descriptor is rejected; no macOS buttons or Linux beta controls render | `server/local-computer.test.ts`, capability screenshot | P0 |
| WB-PLAT-003 | Ubuntu GNOME/Xorg Host Workbench | Enable host workbench | `WB-HOST-XORG` | Opt in, validate, restart, retry | Certified bundled driver starts privately; Ready describes private cursor; local connection is approval-scoped | Wrong arch/version/hash/tool set/path ownership/session/probe fails closed and is recoverable | `electron/cua-linux*.test.mjs`, `server/local-computer.test.ts` | P0 |
| WB-PLAT-004 | Ubuntu GNOME/Wayland | Host control and preview | `WB-HOST-WAYLAND` | Open Workbench and System | Host control says unavailable and directs to Ubuntu on Xorg; portal-mediated view-only preview remains usable | XWayland `DISPLAY` cannot bypass seat gate; non-GNOME/headless stays unavailable | `electron/capabilities.test.mjs`, `electron/cua-linux-runtime.test.mjs`, screenshot | P0 |
| WB-PLAT-005 | macOS/Linux Isolated Workbench | Runtime discovery | Docker, Podman, Colima, and Apple container permutations | Re-check setup | Running supported runtime wins; status names runtime/daemon/image accurately | Installed-but-stopped runtime does not outrank a running one; Apple container cannot guess dynamic per-operator port | `server/container-computer.test.ts`, status JSON | P1 |
| WB-PLAT-006 | Windows Isolated Workbench | Runtime discovery | Docker and Podman permutations | Re-check and prepare | Supported Podman image store is selected when both are healthy; WSL mount is validated; Podman guide is offered | Apple container is never detected; unsafe/public/malformed mount stays unready | `server/container-computer.test.ts`, Windows screenshot/inspect | P1 |
| WB-PLAT-007 | Managed Remote | Box prerequisites | `WB-BOX-FAKE`, configured/unconfigured/invalid token | Open Remote and save token | Missing token exposes inline write-only setup; valid token retries status; auth/billing/rate errors are actionable | Token never returns from config, UI, logs, transcript, diagnostics, or screenshot alt text | `server/box-*.test.ts`, network trace | P0 |
| WB-PLAT-008 | Self-hosted Remote | VPS prerequisites | `WB-VPS-FAKE`, alias present/missing/invalid | Select VPS and Remote | Valid alias enables status/provision; Auto only reuses ready container unless explicitly opted into automatic start | Shell metacharacters, URL, whitespace, unknown alias, or mid-turn alias change is refused | `server/vps-computer.test.ts`, `server/vps-routing.test.ts`, config response | P0 |
| WB-PLAT-009 | Browser development shell | Desktop-only surfaces | `window.helmryth` absent | Open Workbench | Browser Workbench reports “Open Helmryth Desktop”; Host unavailable; server-rendered settings remain stable | No undefined bridge exception, native blank overlay, repeated retry loop, or false capability | `src/lib/desktop.test.ts`, browser screenshot/console | P1 |
| WB-PLAT-010 | All rendered platforms | Design/accessibility baseline | 390, 768, 1440; reduced motion on/off | Exercise every state in this chapter | Warm light Helmryth tokens, visible focus, 4.5:1 text, semantic state plus icon/text, no dark/glow/gradient; motion-safe spinners stop under reduced motion | 200% zoom, long operator/profile/error text, RTL-like long strings, and OS font scaling do not hide critical actions | `DESIGN.md`, `scripts/check-contrast.mjs`, screenshots/axe/accessibility tree | P1 |

## App HTTP route ledger

Each route is called once successfully and once with an unknown operator where applicable. Mutation routes also receive missing/wrong content type, null/array/string body, oversized JSON, duplicate concurrent POST, aborted client, delayed handler, server restart, and boot-token failure. The response must be JSON, never HTML or a secret-bearing raw exception.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-API-001 | `GET /api/local-computer` | System status poll/Re-check | `WB-VM-SHARED` | GET with boot token | 200 typed status: runtime, daemon, image/digest facts, boundary states, paths, viewer, commands, mode, max, idle timeout | Poll abort is silent; invalid runtime output becomes safe unready status; no token in logs | `server/container-computer.test.ts`; retained body | P1 |
| WB-API-002 | `POST /api/local-computer/pull` | Prepare Workbench image | Running runtime, no image | JSON POST | 200 only after pinned base and verified derivative prepare; subsequent status image true | 415 form, 409 overlap, checksum/zero-byte/wrong label fail closed; retry leaves no false prepared state | `server/container-computer.test.ts` | P0 |
| WB-API-003 | `POST /api/local-computer/run` | Create shared Workbench | Shared mode, prepared image | JSON POST | Managed constrained container starts; idle timer touched; status progresses running to ready | 409 in dedicated mode, active owner, concurrent lifecycle, missing image, unsafe runtime; no partial public viewer | `server/index.ts`, `server/container-computer.test.ts` | P0 |
| WB-API-004 | `POST /api/local-computer/start` | Start shared Workbench | Safe stopped shared container | JSON POST | 200 and idle timer renewed only for a safely startable managed target | Stale X lock/outdated image/unmanaged/active conflicting action refuses and points to replacement | `server/container-computer.test.ts`, status/inspect | P0 |
| WB-API-005 | `POST /api/local-computer/stop` | Stop | Running, no owner | JSON POST | Container stops and idle timer cancels; durable workspace remains | Active owner/turn and overlapping lifecycle return 409 without interruption or data mutation | `server/index.ts`, `server/local-vm-idle.test.ts` | P0 |
| WB-API-006 | `POST /api/local-computer/remove` | Confirm Delete | Existing, no owner | JSON POST | Only managed disposable container/viewer removed; durable workspace/browser sign-ins remain as promised | Cancel makes no call; unmanaged target, active owner, duplicate removal, daemon loss fail safely | `server/container-computer.test.ts`, inspect/filesystem proof | P0 |
| WB-API-007 | `POST /api/local-computer/screenshot` | Shared preview | Ready shared target | POST | 200 `{image}` is whole validated image and touches idle timer | Truncated/wrong image or unavailable driver returns error, never partial data rendered as frame | `server/container-computer.test.ts` | P1 |
| WB-API-008 | `POST /api/local-computer/interrupt` | Confirm Linux disable | Active Host runs, JSON | POST | All operators on Host are interrupted with `Promise.allSettled`; 200 `{ok:true}` even when none active | 415 form; one adapter rejection cannot strand other runs; remote/isolated runs untouched | `server/index.test.ts` “idempotent stop boundary” | P0 |
| WB-API-009 | `GET /api/bots/:id/local-computer` | Operator VM status/Split pane | `WB-VM-DEDICATED` | GET Rivet then Cairn | Each returns its own opaque target, workspace, port, readiness; no cross-target state | Unknown 404; shared mode resolves shared target; unsafe facts force ready false | `server/index.test.ts`, `src/lib/local-vm-workspace.test.ts` | P0 |
| WB-API-010 | `POST /api/bots/:id/local-computer/run` | Create operator workbench | Dedicated, image, below max | JSON POST twice concurrently | One create succeeds; target lifecycle/provision fences prevent duplicate and capacity oversubscription | Shared mode, no runtime, max reached, active lease, image busy return 409 and remain recoverable | `server/index.ts`, `server/container-computer.test.ts` | P0 |
| WB-API-011 | `POST /api/bots/:id/local-computer/stop` | Stop operator VM | Dedicated running target, idle operator | JSON POST | Stops only that target and cancels its idle timer | Active owner/turn, wrong operator, simultaneous remove fail without affecting sibling | `server/local-vm-lease.test.ts`, target inspect | P0 |
| WB-API-012 | `POST /api/bots/:id/local-computer/remove` | Confirm operator Delete/Replace | Dedicated existing target | JSON POST | Removes only requested managed target; private durable workspace stays | Busy operator disables UI and server rejects race; sibling target/view/lease stays live | `server/index.ts`, `server/container-computer.test.ts` | P0 |
| WB-API-013 | `POST /api/bots/:id/local-computer/screenshot` | VM panel preview | Ready dedicated target | POST at idle/busy cadence | Whole screenshot for exact target; activity renews its idle timer | Viewer open/page hidden suppresses renderer poll; invalid image shows alert and next tick can recover | `src/components/ComputerPanel.tsx`, `server/container-computer.test.ts` | P1 |
| WB-API-014 | `GET /api/bots/:id/computer` | Remote status | `WB-BOX-FAKE` and `WB-VPS-FAKE` | GET each backend | 200 includes `backend` and only backend-appropriate typed status | Unknown 404; unconfigured, stopped, incompatible, transport-failed remain distinguishable; secrets absent | `server/vps-computer.test.ts`, `server/box*.test.ts` | P0 |
| WB-API-015 | `GET /api/bots/:id/computer/control` | Mount/expanded/split reconciliation | Any operator | GET before/during/after hold | 200 secret-free `{held, helpReason}`; read never changes ownership | Stale response cannot overwrite newer SSE/native state; unknown 404; boot token enforced | `server/index.test.ts`, `server/computer-control.test.ts` | P0 |
| WB-API-016 | `POST /api/bots/:id/computer/control` | take/release/dismiss-help/lease | JSON; plain and UUID lease variants | POST each action | State and SSE update once; lease take returns owned/acquired but never lease id; matching release alone succeeds | 415 form, 400 unknown action/malformed lease; double take preserves held-since; wrong lease cannot release | `server/index.test.ts`, `server/computer-control.test.ts` | P0 |
| WB-API-017 | `POST /api/bots/:id/computer/viewer-close` | Viewer failure/close cleanup | VPS join tunnel open | JSON POST | 200 closes only that operator’s loopback SSH tunnel; Box returns `{closed:false}` | Wrong operator 404; duplicate close idempotent; one viewer cannot close another’s context | `server/index.ts`, `electron/desktop-viewer.node-test.mjs` | P0 |
| WB-API-018 | `POST /api/bots/:id/computer/provision` | Prepare/Start Remote | Explicit Remote or opted-in Auto | JSON POST Box and VPS | Box find/create/ready/bootstrap/fresh join; VPS pinned managed container ready; UI moves to ready | VPS Auto without opt-in 409; same-bot concurrent provision serialized; failures never overwrite unmanaged target | `server/box-provision.test.ts`, `server/vps-computer.test.ts` | P0 |
| WB-API-019 | `POST /api/bots/:id/computer/join` | Open live Workbench | Ready Box/VPS | JSON POST | Fresh Box link or loopback VPS SSH viewer link returned only to immediate viewer handoff | Companion header on VPS gets 409; timeout/invalid URL releases newly taken controls and closes tunnel | `server/index.ts`, `server/vps-computer.test.ts`, `electron/desktop-viewer.node-test.mjs` | P0 |
| WB-API-020 | `POST /api/bots/:id/computer/sleep` | Sleep | Ready idle Remote | JSON POST | Box quiesces Chrome then archives; VPS stops only managed container; UI shows archived/stopped | Busy/active VPS returns 409; transport failure keeps honest state; double sleep recoverable | `server/box-lifecycle.test.ts`, `server/vps-computer.test.ts` | P0 |
| WB-API-021 | `POST /api/bots/:id/computer/exec` | Scoped remote console/tool | Box fixture | JSON `{command}` | Box executes max 4000 chars in credential-stripped environment and bounds stdout/stderr | VPS returns 409; empty/oversized/metacharacter command cannot expose host/provider secrets | `server/computer-proxy.test.ts`, `server/index.ts` | P0 |
| WB-API-022 | `POST /api/bots/:id/computer/screenshot` | Remote preview | Ready Remote | JSON POST | Whole JPEG/PNG with declared format; panel produces correct data URL; secret URLs absent | Corrupt/truncated/error HTML is rejected; hidden/viewer-open suppresses poll; next poll recovers | `server/box.ts`, `server/vps-computer.test.ts`, `server/computer-proxy.test.ts` | P1 |
| WB-API-023 | `POST /api/bots/:id/computer/remove` | Confirm Replace VPS | Managed incompatible VPS | JSON POST then provision | Managed old container removed and fresh pinned one created; UI ready or explicit error | Box 409; unmanaged VPS never removed; busy/active turn 409; failed replacement is not shown ready | `server/vps-computer.test.ts`, `src/lib/vps-computer.test.ts` | P0 |
| WB-API-024 | `PATCH /api/bots/:id` | Execution surface/backend/automatic start | Valid operator/provider | Persist `computer`, `cloudBackend`, `autoStartVps`, browser profile | 200 persisted operator and SSE/store update; reload preserves exact choice | Host+Auto requires `acknowledgeLocalAuto`; busy VPS backend/alias race refused; wrong types/enums no partial write | `server/index.test.ts` “grants Auto” and VPS tests | P0 |
| WB-API-025 | `PATCH /api/config` | VM allocation/max, browser profiles, Box/VPS config | Valid QA config | Save each Workbench setting | Typed config persists; status refresh reflects mode/max/profile; secrets return only configured booleans | Null/wrong type/max outside 1–4/duplicate profile/invalid alias/overlap fails without corrupting prior config | `server/index.test.ts`, `src/components/LocalComputerSection.tsx`, retained config diff | P0 |

## Native IPC and event ledger

All IPC calls must reject callers other than the owning main app window where the implementation scopes ownership. Arguments are tested as null, arrays, objects with inherited properties, oversized strings, malicious protocols, invalid bounds, destroyed windows, renderer reload, and simultaneous requests. IPC errors shown in UI must be human-safe and must not echo viewer tokens.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-IPC-001 | `desktop:capabilities` | Provider mount | Desktop build | Invoke at launch | Typed platform/session/preview/local-control capabilities returned | Rejected/late query falls back safely; newer pushed revision wins | `src/lib/desktop.test.ts`, `electron/capabilities.test.mjs` | P0 |
| WB-IPC-002 | `desktop:capabilities-changed` | Native readiness push | Enable/retry/daemon exit | Observe event | Renderer updates once to newest state; controls/labels reflect it | Late initial promise cannot regress state; unmount unsubscribes | `src/components/DesktopCapabilities.tsx`, `src/lib/desktop.test.ts` | P0 |
| WB-IPC-003 | `cua:linux-status` | Linux panel mount | Xorg/Wayland/off | Invoke | Secret-free typed enabled/status/driver identity | Never inspects or executes before explicit opt-in; corrupt preference remains off | `electron/cua-linux-runtime.test.mjs` | P0 |
| WB-IPC-004 | `cua:linux-enable` | Enable host workbench | Xorg, opt-in off | Invoke once/double click | Coalesced private driver start and certified descriptor; capability push Ready | Wrong arch/hash/path/session/tools/changed identity fails closed and remains retryable | `electron/cua-linux*.test.mjs` | P0 |
| WB-IPC-005 | `cua:linux-disable` | Confirm disable | Enabled, active runs interrupted | Invoke | Owned daemon shuts down; durable opt-in clears; capability push Off | Disable during start serializes; only private owned files/process are cleaned | `electron/cua-linux-runtime.test.mjs` | P0 |
| WB-IPC-006 | `cua:linux-retry` | Try again/Re-check access | Enabled but not ready | Invoke | Fresh inspection/start; typed ready or actionable recovery state | Concurrent enable/retry serialized; stale child exit cannot invalidate newer owner | `electron/cua-linux-runtime.test.mjs` | P0 |
| WB-IPC-007 | `screen:preview-intent` | Choose/Start preview | Linux supported session | Synchronous arm then `getDisplayMedia(video)` | Exactly one current renderer-frame video-only request accepted | Expired, wrong frame/origin, audio, second request, missing source rejected | `electron/screen-preview.test.mjs` | P0 |
| WB-IPC-008 | `screen:frame` | macOS Host panel poll | Screen Recording granted/denied | Invoke at busy/idle cadence | Data URL from app-owned capture or empty result; no server hop | Three misses show Settings recovery; hidden panel stops poll; unmount clears interval | `electron/main.mjs`, manual TCC evidence | P1 |
| WB-IPC-009 | `perm:open-settings` | Accessibility/Screen buttons | macOS | Invoke only named panes | Opens exact System Settings privacy anchor; UI waits and retries on visible focus | Unsupported platform false; inherited `constructor`/unknown pane cannot access property-chain value | `electron/main.mjs`, manual deep-link evidence | P0 |
| WB-IPC-010 | `desktop:open-external` | External page/guide link | Valid HTTPS/current browser URL | Invoke | Only http/https passed to OS browser; true after open | file/javascript/data/chrome/userinfo-invalid/non-string rejected without opening | `electron/main.mjs`, shell spy | P0 |
| WB-IPC-011 | `desktop-viewer:open` | Open live Workbench | Valid Box HTTPS or loopback VM/VPS URL | Invoke with title/context | Sandboxed owned viewer opens, state event names context but never URL | HTTP remote, privileged protocol, URL userinfo, invalid/secret-bearing error rejected without echo | `electron/desktop-viewer.node-test.mjs` | P0 |
| WB-IPC-012 | `desktop-viewer:close` | Return controls/panel cleanup | Viewer context A open | Close A, then try B | A closes and reports state; mismatched B returns false and A remains | Duplicate close safe; destroyed window does not throw into renderer | `electron/main.mjs`, viewer state capture | P0 |
| WB-IPC-013 | `desktop-viewer:state-now` | Panel remount | Viewer open/closed | Invoke | `{open,contextId}` seeds poll suppression accurately | No URL/token/title; stale other-context state does not suppress current panel | `src/components/ComputerPanel.tsx`, state capture | P1 |
| WB-IPC-014 | `desktop-viewer:state` | Viewer lifecycle event | Open then close/crash | Observe | Current panel updates viewerOpen and resumes preview after close | Other operator event cannot flip current context; listener removed on unmount | `src/components/ComputerPanel.tsx`, manual event trace | P1 |
| WB-IPC-015 | `desktop-workspace:open` | Split pane selected | Ready loopback viewer URL/bounds | Open two contexts | Two sandboxed watch-only views, unique identities; secret URL absent from emitted state | Duplicate identity/context, third view, non-loopback/invalid URL, bad bounds rejected without echo | `electron/desktop-workspace.node-test.mjs` | P0 |
| WB-IPC-016 | `desktop-workspace:layout` | Resize/scroll/overlay | Two views open | Send clamped bounds and visibility | Views align to hosts; intersecting modal/menu hides them; ordinary positioned content does not | Malformed/off-owner bounds clamp/reject; queued layout cannot revive closed/replaced pane | `src/lib/local-vm-workspace.test.ts`, `electron/desktop-workspace.node-test.mjs` | P0 |
| WB-IPC-017 | `desktop-workspace:set-interactive` | Take/Return/switch | One API lease owned | Promote A, switch B, demote null | Old pane demoted before release; exactly one interactive view at all times | Overlap/reverse-order race serialized; invalid reload removes view and releases hold fail-closed | `electron/desktop-workspace.node-test.mjs`, `src/lib/local-vm-workspace.test.ts` | P0 |
| WB-IPC-018 | `desktop-workspace:close` | Close pane/workspace | One/both views open | Close context then all | Independent close emits secret-free closed state; all controls demoted first | Close during open never emits ready; queued promotion cannot target reused context | `electron/desktop-workspace.node-test.mjs` | P0 |
| WB-IPC-019 | `desktop-workspace:state` | Native viewer event | Open/layout/interactive/error/close | Observe | UI status and Take disabled/enabled follow exact context | Event has no viewer URL; foreign/replaced context ignored; unmount unsubscribes | `src/components/LocalVmWorkspace.tsx`, event trace | P0 |
| WB-IPC-020 | `browser:available` | Browser feature check | Desktop surface host up/down | Invoke | True only when surface and loopback host exist | Closed window/surface-start failure false, never false-positive tab | `electron/main.mjs`, browser host test harness | P1 |
| WB-IPC-021 | `browser:state` and event | Panel mount/navigation | Browser fixture | Invoke and observe | Secret-bearing live URL stays within native state; UI shows sanitized/display form; loading/history update | Renderer gone/navigation hides view; stale operator event ignored; no state leaks to another operator | `electron/browser-surface.test.mjs` | P0 |
| WB-IPC-022 | `browser:layout` | Panel/expanded host geometry | Native host visible/hidden/overlay | Send compact/expanded/null bounds/profile | Fixed 1280×800 viewport scales compact, is 1:1 expanded; null hides without closing | Scroll/resize/modal/page-hidden/unmount sends null; malformed bounds cannot cover app UI | `electron/browser-surface.test.mjs`, screenshot | P0 |
| WB-IPC-023 | `browser:navigate` | Address submit | Valid address | Submit scheme-less and HTTPS | Normalized web URL loads in correct operator/profile; returns title/url | Empty/invalid/file/chrome/javascript/data refused; busy clears; error has technical detail | `electron/browser-snapshot.test.mjs`, `electron/browser-surface.test.mjs` | P0 |
| WB-IPC-024 | `browser:back`/`browser:forward` | History controls/tools | Two-page history | Invoke each | Correct page and `canGoBack/Forward` state emitted | No previous/next is actionable 400/tool error; rapid opposite calls settle consistently | `electron/browser-surface.test.mjs` | P1 |
| WB-IPC-025 | `browser:forget-profile` | Profile deletion elsewhere | Named shared profile in two operators | Invoke safe id | All views on profile close; storage/cache/auth cleared; other sessions untouched | Guest, empty, over-40, metacharacter, inherited value rejected; no EBUSY directory deletion | `electron/browser-surface.test.mjs`, main-process storage spies | P0 |
| WB-IPC-026 | `browser:close` | Operator/profile cleanup | Active operator view | Invoke | Active view closes and emits closed state; other operators remain | Duplicate close and destroyed renderer safe; window close invokes closeAll | `electron/browser-surface.test.mjs` | P1 |
| WB-IPC-027 | Browser surface security hooks | permission/download/popup/dialog/navigation | `WB-BROWSER-SITE` | Trigger each page behavior | Permission denied, download prevented, popup redirected into same view, dialog auto-answered/reported, non-web navigation blocked | No new window, disk write, privileged origin, app preload, Node bridge, or cross-profile cookie | `electron/browser-surface.test.mjs`; disk/window/session evidence | P0 |

## Workbench panel control matrix

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-PANEL-001 | Operator Workbench panel | Open from operator/workstream | Operator selected | Click Workbench launcher | Aside opens labelled “Rivet Workbench panel”; current phase starts Checking; initial control/status fetches once | Rapid operator switch cancels old updates and resets frames/errors/status | Playwright trace plus network log | P1 |
| WB-PANEL-002 | Panel header | Open Rivet’s operator settings | Panel open | Click settings icon | Correct operator settings opens; focus enters settings | Closing restores a sensible launcher; no global System route confusion | Screenshot/focus trace | P1 |
| WB-PANEL-003 | Panel header | Close Workbench panel | Panel open | Click or keyboard activate close | Panel closes; native browser layout hides; viewer is not silently destroyed unless owning flow closes it | Focus returns to launcher; no orphan polling/listeners | Playwright/heap/network trace | P1 |
| WB-PANEL-004 | Resize separator | Pointer drag | 1440 width, panel 400 | Drag left/right beyond limits | Width changes continuously, clamps 360–960, persists `helmryth-workbench-panel-width` on release | Pointer cancel saves final safe width; blocked storage uses session value; native views realign | Playwright + localStorage | P1 |
| WB-PANEL-005 | Resize separator | ArrowLeft/ArrowRight/Home/End | Focus separator | Press keys | 24px steps; Home 360; End 960; ARIA now/text updates and persists | Other key does nothing; 390 viewport never overflows beyond 100vw | Keyboard video/accessibility tree | P1 |
| WB-PANEL-006 | Workbench surface group | Workbench tab | Browser/Android visible | Activate | `aria-pressed=true`; live-surface content replaces other tab | Re-click idempotent; removal of connected device/browser auto-falls back here | Playwright state | P1 |
| WB-PANEL-007 | Workbench surface group | Android Workbench | Physical USB device connected | Activate then disconnect | Android surface renders; disconnect returns to Workbench | No network ADB device appears; details owned by Android QA chapter | Android bridge status screenshot | P2 |
| WB-PANEL-008 | Workbench surface group | Browser Workbench | Feature + bridge enabled | Activate | Compact browser surface renders with profile and controls | Disabled feature/bridge removes tab and prevents stale native overlay | Browser screenshot | P1 |
| WB-PANEL-009 | Live surface | Loading/empty/status | Every `Phase` fixture | Open panel | Exact distinct copy/icon for checking, unconfigured, starting, ready-no-frame, VM, VM unavailable, VPS unconfigured/incompatible/stopped, local, local unavailable, off, error | No raw JSON as image; state changes announced politely; technical detail only after error | State screenshot set | P1 |
| WB-PANEL-010 | Live surface preview | Frame rendering | Cloud, VM, mac Host frames | Deliver valid frame | Correct MIME/data source and alt “Rivet’s screen”; contain fit; VM watch-only title when noninteractive | Wrong/empty frame never breaks layout; old operator frame never appears after switch | Component E2E/network fixture | P0 |
| WB-PANEL-011 | Preview button | Open Rivet’s live Workbench | Valid join/view URL | Click image or Open | Takes control first, opens owned viewer, pauses operator, suppresses polling | Join/open failure releases newly acquired hold, closes fallback tab/tunnel, shows error | Expanded WB-LIVE-001 | P0 |
| WB-PANEL-012 | macOS preview recovery | Open Settings | Three failed frames | Activate | Opens Screen Recording pane; action remains keyboard accessible | Missing bridge reports safe error; return/relaunch flow never claims permission prematurely | macOS manual evidence | P1 |
| WB-PANEL-013 | VM unavailable | Create Rivet’s workbench | Dedicated, image ready, missing target | Activate | POST run; spinner/disabled; status checks until VM or actionable unavailable | Double click one mutation; max/race failures shown; no misleading ready | API trace, WB-API-010 | P0 |
| WB-PANEL-014 | VM unavailable | Replace Rivet’s workbench | Existing unsafe/outdated target | Activate | Destructive Gate opens before any remove | Cancel/Escape no call; busy or failed removal never attempts unsafe create | Expanded WB-GATE-001 | P0 |
| WB-PANEL-015 | VM unavailable | Open Isolated Workbench setup | Shared/not prepared/unsupported | Activate | System opens at stored `computer` section | Blocked sessionStorage still opens System default without crash | Playwright route/state | P1 |
| WB-PANEL-016 | Remote unavailable | Open Remote Workbench settings | VPS missing/stopped | Activate | System Connections opens | Repeated instance of button behaves identically; focus remains usable | Playwright | P1 |
| WB-PANEL-017 | Remote stopped/unprepared | Start/Prepare Remote Workbench | Explicit Remote or Auto opt-in | Activate | Provision POST; spinner; ready or exact error/state | No Auto opt-in leaves no start action; duplicate request disabled/serialized | API/UI trace | P0 |
| WB-PANEL-018 | Incompatible Remote | Replace Remote Workbench | Managed, existing, image mismatch | Activate | Gate explains disposable loss and offers Replace | Unmanaged target has no destructive action; failed removal/provision ends error | Expanded WB-GATE-002 | P0 |
| WB-PANEL-019 | Inline managed Remote setup | Box API key row | Box unconfigured | Save valid/invalid key | Valid configured result retries; invalid provider response remains write-only and actionable | Paste/blur/Enter/duplicate; token never echoed or stored in renderer-readable state | Box config tests/network trace | P0 |
| WB-PANEL-020 | Split launcher | Open Split Workbench | Dedicated VM ready, desktop bridge | Activate | Full workspace opens with primary operator and focus on main | Hidden in shared mode/browser/no bridge; busy pending disables double launch | Split screenshot/focus | P1 |
| WB-PANEL-021 | Help plea | Take controls | `helpReason`, not held | Activate | Opens applicable viewer and acquires control; plea clears on eventual release | Viewer failure releases hold; simultaneous dismiss/take results in one coherent state | Control/API/event trace | P0 |
| WB-PANEL-022 | Help plea | Dismiss | Open plea | Activate | POST dismiss-help; plea clears, operator continues, no hold | Double dismiss no phantom broadcast; reason cannot be clobbered by later request | `server/computer-control.test.ts` | P0 |
| WB-PANEL-023 | Held notice | Return controls | Person holds | Activate | POST release then closes matching viewer; UI says operator can act | Wrong context stays open; API failure keeps honest held UI and surfaces error | Control and native traces | P0 |
| WB-PANEL-024 | VM ready | Take controls | Viewer URL, no plea/hold | Activate | Operator pauses; in-app watch-only viewer reloads interactive; button becomes Return/Open | Missing URL disables; open failure releases; no click-through in preview | Native/control trace | P0 |
| WB-PANEL-025 | VM ready | Delete Isolated Workbench | Dedicated idle operator | Activate | Gate opens; after confirm only target removed; UI unavailable | Disabled while operator busy or any pending action; title explains why | Expanded WB-GATE-001 | P0 |
| WB-PANEL-026 | Remote ready | Take controls/Open live | Box/VPS ready | Activate | Fresh join, owned viewer, correct control text | Pop-up blocked web fallback is handled without losing hold; invalid URL fails cleanly | WB-LIVE-001 | P0 |
| WB-PANEL-027 | Remote ready | Sleep | Ready idle Remote | Activate | Spinner; Box archived or VPS stopped; preview/actions update | Busy VPS 409 preserves ready/error truth; sleep disabled during own request | WB-API-020 trace | P0 |
| WB-PANEL-028 | Execution surface | Remote | Supported provider | Activate by mouse/keyboard | Bot patch persists `cloud`; phase provisions only under explicit rules | Unsupported control disabled with exact title; same selected value no request | Playwright/API trace | P0 |
| WB-PANEL-029 | Execution surface | Isolated | VM-capable engine | Activate | Bot patch persists `vm`; status/create setup shown | Unsupported disabled; unsafe VM never shown ready | Playwright/API trace | P0 |
| WB-PANEL-030 | Execution surface | Host | Approval-capable engine/platform | Activate | Bot patch persists `local`; capability/permission recovery shown | If Auto approvals active, LocalAutoWarning must precede acknowledged patch | Expanded WB-GATE-003 | P0 |
| WB-PANEL-031 | Execution surface | Off | Any operator | Activate | Bot patch persists off; empty state and cadence warning render; no preview/provision polls | Active host turn is interrupted by server when switching away; remote VM not destroyed | API/Playwright trace | P0 |
| WB-PANEL-032 | Hosted Workbench picker | Box/Self-hosted VPS | Automatic or Remote | Switch each backend | Patch persists; pressed visual state and the exact Box-managed/VPS automatic-placement explanation update | Self-hosted VPS is disabled with exact title for an unsupported engine; switch blocked during active VPS turn | VPS routing test and UI trace | P0 |
| WB-PANEL-033 | Automatic VPS | Start Remote Workbench automatically switch | Automatic + VPS | Toggle on/off | `role=switch`, aria checked, persisted; off by default; on permits create/wake at next work | Rapid toggles settle last value; disabling does not destroy running container | API/store trace | P0 |
| WB-PANEL-034 | Cadences | Running cadence row | Active run | Activate | Cadences view opens; queued spinner is static, running/waiting state accurate | Stale completed run disappears without stealing focus | Playwright/state fixture | P1 |
| WB-PANEL-035 | Cadences | Up to three cadence rows | 1, 3, 4 routines | Activate each | Sort enabled first/next run; schedule/Remote label/Paused/next time accurate; opens Cadences | Fourth not silently counted as three; timezone/DST/invalid historical date handled by cadence owner | Component screenshot/store fixture | P1 |
| WB-PANEL-036 | Cadences | Create cadence | Any operator | Activate, save/cancel editor | Editor locks correct operator; default remote only when backend ready; saved cadence appears | Off surface warns; canceled editor no mutation; focus returns | Routine integration trace | P1 |
| WB-PANEL-037 | Cadences | Cadences | Any operator | Activate | Global Cadences opens | Keyboard name/title exact; no creation side effect | Playwright | P2 |

## System → Isolated Workbench controls

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-SETUP-001 | Isolated Workbench status | Initial 5-second poll | Each runtime state | Enter section | Loading then typed Ready/problem; subsequent polls; unmount aborts | Abort has no alert; failed parse/request shows status unavailable and technical detail | Network/console trace | P1 |
| WB-SETUP-002 | Status header | Re-check | Poll settled | Activate | Immediate fresh poll; disabled while loading/mutation | Repeated activation creates one loop; old response cannot replace new status | Playwright network trace | P1 |
| WB-SETUP-003 | Shared ready | Watch screen link | Ready shared viewer | Activate | New tab with `noreferrer` opens protected loopback viewer | Link absent in dedicated/unready; non-loopback/invalid viewer rejected at producer boundary | DOM/link/viewer evidence | P0 |
| WB-SETUP-004 | Allocation | Shared workbench | Valid status | Activate | PATCH mode shared, saving status, refresh; current pressed state | Active mode change conflict fails without local optimistic lie | API/config diff | P0 |
| WB-SETUP-005 | Allocation | Dedicated per operator | Docker/Podman | Activate | PATCH per-bot; header becomes ready for dedicated; create moves to operator panels | Apple container explains unsupported dynamic ports; no shared VM auto-create | API/UI trace | P0 |
| WB-SETUP-006 | Allocation | Maximum dedicated workbenches 1–4 | Dedicated | Select each | PATCH integer; refresh keeps chosen value; capacity enforces it atomically | Null/string/0/5/rapid changes rejected/last safe value retained | API and config tests | P0 |
| WB-SETUP-007 | Prepare step 1 | Installation guide/command | No runtime | Open guide or copy command | Correct platform option, new-tab security, no command auto-execution | Offline link failure does not claim install; Docker licensing copy remains visible | Screenshot/link audit | P2 |
| WB-SETUP-008 | Prepare step 2 | Runtime start command | Installed stopped runtime | Copy/run externally then Re-check | Daemon status becomes true, next step enables | Command cannot include token/home traversal; UI never executes it silently | Command snapshot/status | P1 |
| WB-SETUP-009 | Prepare step 3 | Prepare Workbench image | Daemon up | Activate | Pull/build once; spinner; exact pinned refs/driver version shown | Network loss/checksum/version/label failure recoverable and image false | WB-API-002, inspect | P0 |
| WB-SETUP-010 | Prepare step 3 | Show base-image download | Command present | Toggle details | Exact pinned base pull appears and is keyboard/screen-reader operable | Closed default; command contains no secret; narrow layouts wrap/scroll safely | DOM screenshot | P2 |
| WB-SETUP-011 | Prepare step 4 | Create Isolated Workbench | Shared/image/missing | Activate | Secure managed shared target created, progress says Waiting then Ready | Duplicate click disabled; desktop timeout surfaces bounded problem | WB-API-003, status screenshots | P0 |
| WB-SETUP-012 | Prepare step 4 | Start Isolated Workbench | Safe stopped state | Activate | Starts only safe managed target | Unsafe/stale state shows Replace, not Start | WB-API-004 | P0 |
| WB-SETUP-013 | Prepare step 4 | Delete and recreate | Unsafe/outdated existing | Activate then cancel/confirm | Gate; confirm remove then run; durable data remains; new verified state | Remove succeeds/run fails shows honest missing/error; retry can create | WB-GATE-004 | P0 |
| WB-SETUP-014 | Prepare step 4 | Show command | Command present | Toggle | Exact target-specific safe command shown | No shell interpolation secret; paths wrap without page overflow | DOM/security review | P1 |
| WB-SETUP-015 | Boundaries/storage | Stop | Shared running, idle | Activate | Stop only managed container, status stopped | Active owner returns 409; button disabled during mutation | WB-API-005 | P0 |
| WB-SETUP-016 | Boundaries/storage | Delete workbench/shared workbench | Existing idle | Activate cancel then confirm | Correct label; destructive Gate; disposable target removed only | Durable path remains; wrong target/unmanaged container untouched | WB-GATE-004, filesystem proof | P0 |
| WB-SETUP-017 | Boundaries/storage | Technical boundaries details | Shared and dedicated | Expand | Exact loopback, persistence, target isolation, 4GB/2CPU/512 process/minimal-cap language | Inspect contradicting any claim fails acceptance even if UI says Ready | UI + container inspect | P0 |
| WB-SETUP-018 | Runtime recovery | Status request/daemon failure | Kill runtime mid-poll | Wait then recover | Status unavailable/problem; Re-check after restart reaches correct state | No request storm, stale ready, leaked process, or destructive automatic action | Network/process trace | P1 |
| WB-SETUP-019 | Idle lifecycle | 8-hour inactivity/activity | Fake clock, ready VM | Advance/touch/advance | Complete idle window suspends; screenshot/run activity renews; active work defers full window | Transient stop failure rearms; manual stop cancels; delayed stale event cannot revive owner | `server/local-vm-idle.test.ts` | P0 |
| WB-SETUP-020 | Ownership lifecycle | Shared/dedicated leases | Two threads/two targets | Acquire/renew/release/expire | Shared serializes; dedicated targets run concurrently; owner renews; wedged owner expires | Nonowner cannot release; delayed event cannot revive; delete blocked while owned | `server/local-vm-lease.test.ts` | P0 |

## Host Workbench and preview controls

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-HOST-001 | macOS preparation | Open Accessibility | Grant missing | Activate | Exact pane opens; button says Waiting; returning visible triggers one retry | While waiting all permission buttons disabled; open failure clears wait and alerts | Manual macOS focus/IPC trace | P0 |
| WB-HOST-002 | macOS preparation | Open Screen Recording | Grant missing | Activate | Exact pane opens; return triggers retry; relaunch instruction remains accurate | Accessibility-only does not claim ready; denied cannot be inferred as granted | Manual macOS evidence | P0 |
| WB-HOST-003 | macOS preparation | Re-check access | Permissions changed | Activate | Retry spinner then capability updates | Missing bridge safe error; double activation one retry | IPC/state screenshot | P1 |
| WB-HOST-004 | macOS panel preview | Screen frame lifecycle | Host selected, permissions matrix | Observe idle/busy/hidden | First capture prompts when needed; valid frame at 30s idle/3s busy; hidden stops; unmount cleans | Three misses show Settings; no false spinner forever; stale operator frame cleared | Manual timing/network trace | P1 |
| WB-HOST-005 | Linux host card | Enable host workbench (Beta) | Xorg, off | Activate | Explicit opt-in, pending spinner, Ready or Needs attention | Wayland button absent; no driver inspection before activation; restart respects durable opt-in | `electron/cua-linux-runtime.test.mjs`, UI trace | P0 |
| WB-HOST-006 | Linux host card | Try again | Enabled, failed driver | Activate | Fresh private validation/start; trace copy remains available | File identity changed between inspect/spawn refuses; concurrent retry serialized | CUA tests and UI trace | P0 |
| WB-HOST-007 | Linux host card | Stop active runs and disable | Enabled | Activate | Alertdialog opens, initial focus Keep Host Workbench | No interrupt/disable before confirm; Escape/cancel restores trigger focus | WB-GATE-005 | P0 |
| WB-HOST-008 | Linux host card | Driver trace & recovery | Any Linux status | Toggle details | Packaged/source-specific recovery, safe driver label/version | Absolute internal path appears only where intended and cannot be clicked/executed; long path wraps | DOM screenshot | P1 |
| WB-HOST-009 | Wayland safety | Unavailable on Wayland state | `WB-HOST-WAYLAND` | Open | Exact Xorg remediation; alternate surfaces/preview remain available | No enable/retry/disable host-control action; forged ready event cannot lift gate | Capability/CUA tests | P0 |
| WB-HOST-010 | Host preview | Start preview/Choose a screen | Linux supported preview | Activate and select | One intent, one video-only stream, source label/live status, view-only copy | Picker cancellation says nothing shared; unavailable/headless disabled; no pointer/keyboard grant | `electron/screen-preview.test.mjs`, MediaStream trace | P0 |
| WB-HOST-011 | Host preview | Stop preview | Stream active | Activate | Tracks stop, video `srcObject` clears, returns idle | OS-ended track reports ended; unmount always stops; late successful selection after cancel is stopped | MediaStream spies/manual portal | P0 |
| WB-HOST-012 | Host preview | Try again | cancelled/ended/error/unavailable then restored | Activate | Fresh intent and correct result | `video.play()` rejection ends stream and shows error; repeated retry no orphan tracks | Component E2E | P1 |
| WB-HOST-013 | Host action Gate | Approval-scope enforcement | Operator on Host, Auto off | Trigger inspect/click/type tool | Every host action reaches visible Gate; scope `local-computer`; remembered generic grants do not bypass | Auto-review never self-approves host request; cancel/refuse makes no host input | auto-approve/review and driver tests | P0 |
| WB-HOST-014 | Host Auto warning | Host with Auto approvals | Auto on, switch to Host | Confirm warning | Server requires `acknowledgeLocalAuto:true`; accepted state persists | Blind API patch/one-shot Auto rejected; leaving Host interrupts active turn | `server/index.test.ts` | P0 |
| WB-HOST-015 | Linux Driver security | Candidate/path/env validation | Malicious fixtures | Enable/retry | Only certified private executable/owner/mode/arch/hash/manifest/tools and bounded clean env execute | World/group-writable, symlink race, relative/empty PATH, metacharacters, secrets, non-GNOME/headless fail closed | `electron/cua-linux*.test.mjs` | P0 |
| WB-HOST-016 | Linux Driver recovery | Owned daemon exit/restart/shutdown | Ready driver | Kill, retry, quit/relaunch | Readiness revokes immediately; retry creates fresh owner; shutdown closes liveness pipe; prior opt-in restarts safely | Stale child/signal cannot clear newer state; only exact private stage cleaned | `electron/cua-linux-runtime.test.mjs` | P0 |

## Browser Workbench controls and browser-host routes

### Rendered browser controls

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-BUI-001 | Compact Browser header | Open | Browser panel | Activate | Expanded Browser Workbench receives focus; same native page/profile/control state retained | Repeated open no duplicate native view; launcher is focus-return target | Browser screenshots/focus trace | P1 |
| WB-BUI-002 | Native preview | Click/Enter/Space | Compact browser | Activate host box | Same expansion as Open; role/name only when expandable | Native page click cannot leak through during launcher activation; overlay hides native view | Playwright/Electron trace | P0 |
| WB-BUI-003 | Address bar | Submit web address | Empty/current browser | Enter `example.test/path` | Busy/loading state; normalized HTTPS navigation; focus leaves edit on success; displayed URL omits `https://`/trailing slash only for simple host | Empty submit no call; invalid/refused URL retains editable value and shows generic + details | IPC/network trace | P0 |
| WB-BUI-004 | Address bar | Focus/edit/blur | Loaded secret URL | Focus then type then blur | While focused user text is stable; when not focused surface state restores display URL | Query/fragment must not enter transcript/tool output; browser UI may show current address only to local user | Screenshot + proxy output | P0 |
| WB-BUI-005 | Back | Back | Two-page history | Activate | Previous page; disabled state and accessible name update | Disabled at start; rapid calls/no previous show no corrupt history | Surface test/manual | P1 |
| WB-BUI-006 | External browser | Open in your default browser | Current nonblank http(s) | Activate | Valid current URL sent through guarded external IPC | Absent on blank; forbidden protocol cannot reach shell; failure alert | Shell spy/UI trace | P0 |
| WB-BUI-007 | Expanded toolbar | Return browser to Workbench panel | Expanded | Activate close/minimize | Compact panel resumes same page/profile/hold; focus returns launcher | Native view lays out only after compact host exists; no flash over workstream | Screenshot/focus/native trace | P0 |
| WB-BUI-008 | Control card | Take controls | Operator driving, no human hold | Activate | API held true; operator browser actions refuse; status says user holds | Duplicate/race with tool action resolves person-first; pending disables | Proxy/control tests | P0 |
| WB-BUI-009 | Control card | Return controls | Human holds | Activate | Held false; operator resumes from unchanged page | Failed API stays held and alerts; no credentials/actions copied into transcript | Proxy/control tests | P0 |
| WB-BUI-010 | Profile select | Operator private | Named/Guest active | Select private | Unique persistent operator partition shown; previous Guest destroyed | Deleted profile fallback does not resurrect it; no other operator cookies | Surface test/session evidence | P0 |
| WB-BUI-011 | Profile select | Named shared profile | Named profile exists | Select from two operators | Both use same named session partition but distinct views; switch preserves live sessions | A profile deletion closes all matching views and clears data only there | Surface tests/storage evidence | P0 |
| WB-BUI-012 | Profile select | Temporary cleared on switch | Any operator | Select Guest, store cookie, switch away/back | Unique nonpersistent Guest view destroyed on switch; returning creates empty session | Guest cannot be forgotten through named-profile IPC; no disk-identifying remainder | `electron/browser-surface.test.mjs` | P0 |
| WB-BUI-013 | Profile select | + Add profile | Panel | Select | Add form opens; input focused | Selecting item does not immediately mutate config | Focus/network trace | P1 |
| WB-BUI-014 | Add profile button | Toggle | Panel | Activate twice | Form opens/closes; accessible name stable | Closing clears no submitted profile; keyboard focus remains sensible | Playwright | P2 |
| WB-BUI-015 | New profile | Add | Name 1/40 chars | Submit | Slug is collision-safe, config appends, operator selects it, form clears, focus returns Add button | Empty/whitespace disabled; 41st char prevented; duplicate slug suffix; failed PATCH retains typed name/error | Component/API E2E | P0 |
| WB-BUI-016 | New profile | Cancel | Typed unsaved name | Activate/Escape only where form handles it | Form closes, text clears, focus returns Add button | No PATCH or partition creation | Network/focus trace | P1 |
| WB-BUI-017 | Browser error | Technical detail | Navigation/layout/control/profile failure | Expand details | Generic local copy plus bounded safe technical message | No token, URL credential, viewer/profile cookie, filesystem path, stack, or API secret | Error fixtures/redaction audit | P0 |
| WB-BUI-018 | Native browser layout | Overlay/visibility | Open menu/modal/tab hidden | Show/hide overlay and page | View immediately hides on intersecting overlay/page-hidden/unmount and restores correctly | It never paints above Gate/settings/workstream or catches hidden clicks | Electron visual/video trace | P0 |

### Browser-host one-to-one route ledger

All `/v1` routes bind only to `127.0.0.1` on an ephemeral port, require the exact per-boot 64-hex bearer token, reject bodies above 64 KiB, and never emit CORS permission. Run each case with IPv4 loopback, missing/wrong token, non-loopback socket, closed Helmryth window, malformed JSON, invalid operator identifier characters, and renderer/view crash.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-BHOST-001 | `GET /v1/health` | Proxy health | Browser host up/window open and closed | GET with bearer | 200 `{ok,views,window}` accurately reflects manager | 401 wrong token, 403 nonloopback, 404 wrong method/path; descriptor has loopback URL/token/pid only | `electron/browser-host.cjs`, descriptor tests | P0 |
| WB-BHOST-002 | `POST /v1/bots/:id/state` | `browser_state` | Tab blank/loaded/loading | POST `{profile}` | Secret-bearing state stays in host response only; proxy formats safe title/scrubbed URL | 503 window closed; invalid profile type ignored; blank state actionable | browser proxy/surface tests | P0 |
| WB-BHOST-003 | `POST …/navigate` | `browser_navigate` | Fixture | POST valid address | Correct operator/profile view loads and returns fresh observed page | Invalid/nonweb/empty/stalled >30s returns actionable error | browser proxy/surface tests | P0 |
| WB-BHOST-004 | `POST …/back` | `browser_back` | History | POST | Previous page + fresh snapshot | No previous 400, control hold blocks proxy action before host | browser proxy test | P1 |
| WB-BHOST-005 | `POST …/forward` | `browser_forward` | Back performed | POST | Next page + fresh snapshot | No next 400; navigation-changing race invalidates old refs | browser surface/proxy tests | P1 |
| WB-BHOST-006 | `POST …/snapshot` | `browser_snapshot` | Interactive fixture | POST | At most 250 meaningful ordered refs with roles/names/flags, scroll/dialog notes, scrubbed URL in proxy | Stale injected bundle falls back safely; max 60k/field lengths bounded; secrets not in URL | snapshot/surface/proxy tests | P0 |
| WB-BHOST-007 | `POST …/click` | `browser_click` | Latest ref | POST single/double | Center click and fresh snapshot | Invalid/stale/unknown/not-visible ref 400; held control makes zero host action | surface/proxy tests | P0 |
| WB-BHOST-008 | `POST …/hover` | `browser_hover` | Latest visible ref | POST | Pointer moves; hover UI represented in new snapshot | Stale/invisible ref fails; no arbitrary coordinates | surface/proxy tests | P1 |
| WB-BHOST-009 | `POST …/drag` | `browser_drag` | Fresh source/target refs | POST | Mouse sequence drags center-to-center and returns state | Same/stale/missing target safe 400; control hold blocks | surface/proxy tests | P1 |
| WB-BHOST-010 | `POST …/fill` | `browser_fill` | Editable ref | POST up to 4000 chars | Focus/select-all/replace then fresh snapshot | Password/payment/OTP wall must use takeover; noneditable/stale/oversized rejected | surface/proxy tests | P0 |
| WB-BHOST-011 | `POST …/type` | `browser_type` | Focused field | POST up to 4000 chars | Inserts exact text at focus | No focus/oversized/secret input fails or is prohibited; held blocks | surface/proxy tests | P0 |
| WB-BHOST-012 | `POST …/press` | `browser_press` | Page focused | Press each allowlisted key | Exact CDP key events for enter/tab/escape/backspace/delete/space/arrows/page/home/end | Chords/arbitrary keys/empty rejected; held blocks | surface/proxy tests | P1 |
| WB-BHOST-013 | `POST …/scroll` | `browser_scroll` | Scrollable page | Four directions, 1/600/5000 | Bounded pixels, fresh snapshot and offscreen hint | 0/5001/NaN/wrong direction rejected | surface/proxy tests | P1 |
| WB-BHOST-014 | `POST …/select` | `browser_select_option` | select/multi-select ref | Select by value and label | Matching option(s), input/change events, fresh snapshot | Empty, nonexistent option, many values on single select, nonselect ref rejected | surface/proxy tests | P1 |
| WB-BHOST-015 | `POST …/wait` | `browser_wait_for` | Slow fixture | Wait text, URL, both, neither; 250/30k | Polls until conditions or settle and returns fresh page | Timeout capped 30s, cancellation/window close safe, no unbounded timer | surface/proxy tests | P1 |
| WB-BHOST-016 | `POST …/read` | `browser_read` | Article/empty/large fixture | POST | Plain visible text max 24k and scrubbed title/URL | Script/hidden text omitted; empty copy explicit; no cookies/query/fragment | surface/proxy tests | P0 |
| WB-BHOST-017 | `POST …/screenshot` | `browser_screenshot` | Loaded page | POST | Whole 1024-wide JPEG quality 70 or PNG, correctly typed | Capture failure/corrupt bytes error; image used only when semantic list insufficient | surface/proxy tests | P1 |

## Split Workbench controls

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-SPLIT-001 | Split Workbench | Initial slots | `WB-VM-DEDICATED`, primary Rivet | Open | Rivet left, another eligible nonhidden VM right, main focused; both watch-only | Ineligible/deleted/hidden operators excluded; no duplicate | `src/lib/local-vm-workspace.test.ts`, screenshot | P0 |
| WB-SPLIT-002 | Pane 1/2 selector | Choose operator/empty | Three eligible operators | Select each/Choose | Pane closes old native view, fetches new safe status, opens new watch-only view | Choosing operator in other pane swaps/reconciles, never duplicates; pending disables | slot tests/native trace | P0 |
| WB-SPLIT-003 | Pane status | Checking/connecting/live | Delayed status/native open | Observe | Exact live region: checking, connecting, Live watch-only | Native ready after pane close cannot resurrect state | workspace node tests | P1 |
| WB-SPLIT-004 | Pane status | Missing/stopped/unsafe/error | Status matrix | Open each | Alert with exact state; Retry status and Open Workbench visible | Unsafe network/security/persistence/desktop force unready even if raw ready true | workspace lib tests | P0 |
| WB-SPLIT-005 | Pane error | Retry status | Recoverable failure | Activate | Refetch/reopen exact pane only | Repeated retry serializes open/close; stale result ignored | Native/API trace | P1 |
| WB-SPLIT-006 | Pane error | Open Workbench | Failed pane, other control held/not held | Activate | Releases workspace-owned hold before returning to operator panel | Failed release keeps workspace open and error visible | Workspace trace | P0 |
| WB-SPLIT-007 | Pane | Take controls | Ready, no external hold | Activate | Atomic lease owned then native pane interactive; only that operator pauses | Rapid two-pane click guarded before React rerender; person-held elsewhere returns Held elsewhere | control/workspace tests | P0 |
| WB-SPLIT-008 | Active pane | Return controls | Workspace owns lease | Activate | Native demotes before API release; operator resumes; pane watch-only | Demotion failure still attempts fail-closed release; release failure leaves honest error/open workspace | workspace tests | P0 |
| WB-SPLIT-009 | Other pane | Switch controls | Pane A owned, B ready | Activate B | A demote → A release → B atomic take → B promote | Any intermediate failure leaves at most one hold and no second interactive pane | workspace tests | P0 |
| WB-SPLIT-010 | Other pane | Held elsewhere | Legacy viewer or another Split owns B | Observe/click | Button disabled “Held elsewhere”; existing owner untouched | Read-only opening never silently releases; lease id never exposed | workspace/control tests | P0 |
| WB-SPLIT-011 | Pane selector | Replace controlled pane | Workspace controls selected operator | Choose another | Hand back succeeds before slot changes; then old view closes/new opens | Release failure aborts selection and preserves pane/hold | Native/control trace | P0 |
| WB-SPLIT-012 | Close Split Workbench | Close | No hold / owned hold | Activate | If owned: demote/release then close all views; focus returns exact launcher | Failed handback keeps workspace open; rapid close/unmount sends keepalive release | Workspace tests/focus trace | P0 |
| WB-SPLIT-013 | Browser/app lifecycle | Reload/crash/unmount | Workspace owns hold | Reload/close/crash | Best-effort keepalive release, all views demoted/closed, no secret URL in state/log | Lost bridge still releases API hold; reconnect GET reconciles true ownership | Process/API trace | P0 |
| WB-SPLIT-014 | Native overlay shielding | Dialog/menu/update banner | Views visible | Overlay intersect one/both panes | Native view visibility false while obscured and restored after | Ordinary fixed/absolute layout with low z-index/nonintersection stays visible | overlay unit test + video | P0 |
| WB-SPLIT-015 | Layout | 390/768/1024/1440 and zoom | Two panes | Resize/scroll/200% zoom | One-column scroll under lg, two columns at lg; each min 320; controls reachable; native bounds aligned | No horizontal page overflow, view overlap, offscreen native input, or hidden close | Screenshot/bounds trace | P1 |
| WB-SPLIT-016 | Eligibility reconciliation | Operator hidden/deleted/surface changed | Selected operator mutation | Apply store update | Removed slot closes, owned lease releases, next eligible fills once | Delayed event cannot re-add removed target or control it | slot tests/native trace | P0 |

## Operator tool, input, and Gate behavior

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-TOOL-001 | Remote/Isolated computer MCP | `screenshot` + crop/settle | Fake desktop | Full and bounded crop | Whole image, stable full-frame hash, changed pixels only resend; crop coordinates validated | Width/height overflow, conversion/truncation/wrong terminator fails closed | `server/computer-proxy.test.ts`, `server/computer-observation.test.ts` | P0 |
| WB-TOOL-002 | Remote computer MCP | `click`, `type_text`, `press_key`, `scroll` | Nobody holds control | Execute boundaries | Correct scaled coordinates/buttons/double, exact leading hyphens/text/keys/scroll; one post-action frame | Invalid coordinates/types/keys and action while human holds do not reach backend | `server/computer-proxy.test.ts` | P0 |
| WB-TOOL-003 | Remote computer MCP | `computer_batch` | Valid desktop | Mixed max-valid actions with capture on/off | Ordered actions, one final capture unless opted out, metrics correct | Invalid/oversized action, wait >5s, mid-batch failure bounded; no hidden later actions after failure | `server/computer-proxy.test.ts` | P0 |
| WB-TOOL-004 | Remote computer MCP | `computer_exec` | Box backend | Execute bounded safe fixture | Credential-stripped environment, bounded output, optional screenshot only when requested | Provider/account env absent; max command/output; VPS uses scoped MCP bridge instead of route exec | proxy/VPS MCP tests | P0 |
| WB-TOOL-005 | Remote computer MCP | `computer_status`/metrics | CUA and degraded X11 | Read | Exact backend and observation/action/retry/verification counters | Read does not act/capture unexpectedly or leak connection details | proxy tests | P1 |
| WB-TOOL-006 | Remote computer MCP | `computer_request_help` | Control service configured/unconfigured | Plea then take/return/dismiss/timeout | First reason visible, waits through hand-back, reports dismissal/timeout/unpageable accurately | Later plea cannot clobber; max reason bounded; no automatic control grant | control/proxy tests | P0 |
| WB-TOOL-007 | Remote semantic browser | state/snapshot/click/fill/navigation verify/open URL | Browser inside Remote | Execute with URL secrets | Fresh refs, scrubbed URL output, exact verification, private profile | Wrong query/invalid expected URL never verifies; credentials/query/fragment absent | proxy/remote tests | P0 |
| WB-TOOL-008 | Built-in browser MCP | 17 named tools | `WB-BROWSER-SITE` | Execute every schema boundary | Host route mapping/output as WB-BHOST-002–017; reads permitted during human hold | All 11 action tools refuse before host when human holds; unknown tool typed error | `server/drivers/browser-proxy.test.ts` | P0 |
| WB-TOOL-009 | Browser sign-in/verification | `browser_request_takeover` | Sign-in, MFA, CAPTCHA fixtures | Ask with reason, user completes privately, returns | UI plea; operator never types password/OTP/solves challenge; on return receives current safe page only | Dismiss/timeout/unconfigured messaging; secret user actions never repeated/transcribed | browser proxy tests/manual credential fixture | P0 |
| WB-TOOL-010 | Host MCP Gate | destructive/sensitive/ordinary action | Host selected | Request each class | Visible Gate states action/resource/consequence/operator; explicit decision required under host scope | Generic remembered allow and auto-review cannot bypass; denial produces no input | auto-approve/review/driver tests | P0 |
| WB-TOOL-011 | Isolated/Remote control ownership | Human hold | Operator attempts all action tools | Execute | Every pointer/keyboard/browser mutation refuses; observation/read may continue only as specified | Release resumes exactly once; stale hold timestamp/lease cannot be bypassed | proxy/control tests | P0 |
| WB-TOOL-012 | Preview streaming | SSE vs polling | Busy operator/live screen event | Start/stop/reconnect | SSE frame wins while flowing; hidden/viewer-open suppresses poll; last transcript frame is fallback | Reconnect/stale screen from another run/operator never overwrites newer frame | App/store E2E | P0 |

## Expanded high-risk scenarios

### WB-LIVE-001 — Live viewer acquisition is atomic and self-cleaning

- **Priority:** P0
- **Execution:** Automated native unit coverage plus Manual — executable end-to-end
- **Platforms:** macOS, Windows, Ubuntu/Xorg; Box, VPS, Isolated
- **Surface / route:** Preview/Open live/Take controls → control API → join or local viewer → desktop viewer IPC
- **Controls / triggers:** preview button, Take controls, Open live Workbench, Return controls, viewer window close
- **Preconditions and fixtures:** ready backend; person does not initially hold; inject success, API timeout, malformed join URL, native open false, popup block, tunnel failure, viewer crash, server restart.
- **Steps:**
  1. Activate Open with keyboard and record the POST order.
  2. Verify control is acquired before any interactive viewer opens.
  3. Drive one pointer and keyboard action and verify the operator is paused.
  4. Close the viewer directly; remount the panel and reconcile state.
  5. Repeat each injected failure before and after control acquisition.
  6. Return controls from the panel and repeat with another operator’s viewer open.
- **Expected visible output:** pending controls disable; one viewer with correct title; held copy is live; on failure one generic alert plus expandable safe detail; matching viewer close resumes preview; focus returns to initiating control.
- **Expected persisted / network output:** take precedes join/open; a newly taken hold is released after failure; VPS viewer-close runs best effort; viewer URLs/tokens are never persisted, logged, placed in React store, analytics, or state events.
- **Failure and recovery assertions:** fallback blank tab closes; tunnel closes; other-context viewer remains; retries do not duplicate holds/windows; restart GET reports actual hold and user can release.
- **Accessibility assertions:** initiator, viewer, and return control have exact accessible names; status is announced once; reduced motion removes spinner animation without hiding pending text.
- **Security and privacy assertions:** only HTTPS remote or loopback viewer; no URL userinfo; same-origin viewer navigation; sandbox, denied permissions, no preload/Node.
- **Cleanup / reset:** release control, close viewer and tunnel, stop fake backend, assert no window/port/listener remains.
- **Automation mapping:** `electron/desktop-viewer.node-test.mjs`, `server/index.test.ts`, `server/computer-control.test.ts`.
- **Evidence to retain:** ordered API/IPC trace, viewer screenshot, focus video, redacted process/port list.

### WB-GATE-001 — Per-operator isolated replacement and deletion preserve durable work

- **Priority:** P0
- **Execution:** Automated — passing at route/container boundaries; Manual — executable UI
- **Platforms:** macOS, Windows, Ubuntu with Docker/Podman
- **Surface / route:** operator panel Replace/Delete → alertdialog → per-operator remove/run
- **Controls / triggers:** Replace workbench, Delete Isolated Workbench, Keep workbench, confirm button, Escape, Tab/Shift+Tab
- **Preconditions and fixtures:** dedicated target containing disposable marker and a durable workspace marker; idle and busy operator variants.
- **Steps:** open each Gate; test initial focus, full focus loop, Escape, cancel, confirm; interrupt response between remove and run; repeat while busy and with unmanaged/wrong-target labels.
- **Expected visible output:** precise target/operator/loss copy; cancel first in focus; busy delete disabled with title; success moves through checking to ready or unavailable after delete.
- **Expected persisted / network output:** no request on cancel; confirm removes exact managed target; replace then calls run; durable marker survives; delete does not call run; sibling target untouched.
- **Failure and recovery assertions:** remove failure leaves old state; run failure leaves honest missing state with Create recovery; double confirm one lifecycle; close/reload never repeats mutation.
- **Accessibility assertions:** `role=alertdialog`, modal, labelled/described, trapped focus, Escape cancellation, trigger focus restoration, 390px scrollable dialog.
- **Security and privacy assertions:** no viewer password/URL in dialog/log; label/target validation; server independently rejects busy/active/unmanaged races.
- **Cleanup / reset:** recreate test target if deleted; verify markers and remove fixture safely.
- **Automation mapping:** `server/container-computer.test.ts`, `server/index.ts`, `electron/desktop-workspace.node-test.mjs`.
- **Evidence to retain:** Gate screenshots, focus trace, API sequence, before/after inspect and filesystem hashes.

### WB-GATE-002 — Incompatible VPS replacement never deletes an unowned container

- **Priority:** P0
- **Execution:** Automated — passing plus Manual — executable UI
- **Platforms:** macOS, Windows, Ubuntu desktop with `WB-VPS-FAKE`
- **Surface / route:** Replace Remote Workbench → remove → provision
- **Controls / triggers:** Replace Remote Workbench, Keep workbench, Replace workbench
- **Preconditions and fixtures:** managed stale image, unmanaged lookalike, active turn, transport failure, rebuild image id change.
- **Steps:** exercise cancel; confirm managed idle; retry provision failure; attempt unmanaged and busy targets; run two simultaneous replacements.
- **Expected visible output:** replacement only offered for existing managed image mismatch; loss copy names disposable VPS container; ready only after exact new image/labels/limits/mount/network/driver.
- **Expected persisted / network output:** remove only `com.helmryth.vps` target for operator; no VPS host shutdown; provision serialized; new image id used; loopback viewer only.
- **Failure and recovery assertions:** unmanaged/busy 409; transport error attributed to link; no implicit deletion; subsequent explicit retry possible.
- **Accessibility assertions:** same modal/focus requirements as WB-GATE-001.
- **Security and privacy assertions:** alias is one validated argv value; no shell interpolation; SSH forward loopback; secrets absent from errors.
- **Cleanup / reset:** close tunnel and remove managed QA container.
- **Automation mapping:** `server/vps-computer.test.ts`, `server/vps-computer.runner.test.ts`, `src/lib/vps-computer.test.ts`.
- **Evidence to retain:** SSH/Docker argv, inspect JSON, dialog screenshot, concurrent request trace.

### WB-GATE-003 — Host plus Auto approvals requires two-layer acknowledgement

- **Priority:** P0
- **Execution:** Automated — passing plus Manual — executable UI
- **Platforms:** macOS, Ubuntu/Xorg
- **Surface / route:** Execution surface Host, LocalComputerAutoWarning, `PATCH /api/bots/:id`
- **Controls / triggers:** Host, Cancel, Grant autonomous host access, backdrop, Escape
- **Preconditions and fixtures:** operator `autoApprove=true`, Host capability selectable, not already acknowledged.
- **Steps:** select Host; cancel by button, backdrop, and Escape; select and activate Grant autonomous host access; send blind API patch without acknowledgement; leave Host and return.
- **Expected visible output:** consequential warning appears before selection; cancel preserves prior surface; confirm selects Host.
- **Expected persisted / network output:** only confirmed request includes `computer:"local", acknowledgeLocalAuto:true`; blind transition rejected 400; already granted state need not reprompt until leaving resets combination.
- **Failure and recovery assertions:** failed PATCH does not close into a false selected state; leaving Host interrupts active local turn.
- **Accessibility assertions:** `role=dialog`, modal, exact labelled/described copy, trapped focus, Escape/backdrop cancellation, 390 behavior, and trigger focus restoration.
- **Security and privacy assertions:** renderer warning is not trusted as boundary; server enforces acknowledgement atomically.
- **Cleanup / reset:** set approvals off and surface Off.
- **Automation mapping:** `server/index.test.ts` “grants Auto on this computer only through the warning acknowledgement”.
- **Evidence to retain:** dialog/focus recording and accepted/rejected PATCH bodies.

### WB-GATE-004 — Shared isolated mutation Gate is cancel-safe and crash-safe

- **Priority:** P0
- **Execution:** Automated route tests plus Manual — executable UI
- **Platforms:** supported container runtimes
- **Surface / route:** System → Isolated Workbench → Delete and recreate/Delete workbench
- **Controls / triggers:** Keep workbench, Replace/Delete workbench
- **Preconditions and fixtures:** shared target with durable/browser-state marker and disposable marker.
- **Steps:** cancel by button/Escape; confirm replace; kill server after remove; reopen and use Create recovery; confirm delete.
- **Expected visible output:** accurate data-retention copy; progress and final state truthful; no automatic repeat after restart.
- **Expected persisted / network output:** cancel zero calls; replace remove then run; durable markers remain; only managed shared target affected.
- **Failure and recovery assertions:** partial failure is visible and recoverable, not silently rolled back or presented ready.
- **Accessibility assertions:** same modal contract as WB-GATE-001.
- **Security and privacy assertions:** runtime inspect/label validation independent of UI.
- **Cleanup / reset:** recreate or remove managed fixture and retain marker hashes.
- **Automation mapping:** `server/container-computer.test.ts`, `server/index.ts`.
- **Evidence to retain:** API fault-injection trace, screenshots, filesystem/inspect diff.

### WB-GATE-005 — Linux disable interrupts Host work before tearing down control

- **Priority:** P0
- **Execution:** Automated server/native boundaries plus Manual — executable UI
- **Platforms:** Ubuntu 24.04 GNOME/Xorg
- **Surface / route:** Stop active runs and disable → interrupt API → Linux disable IPC
- **Controls / triggers:** Keep Host Workbench, Stop runs and disable, Escape
- **Preconditions and fixtures:** two Host operators active, one adapter interrupt rejects, one Remote run active.
- **Steps:** cancel; confirm; inspect call order and final capabilities; retry after injected interrupt route failure.
- **Expected visible output:** copy names interrupted Host runs and unaffected surfaces; disabled while pending; error detail safe; final Off only after successful native disable.
- **Expected persisted / network output:** JSON interrupt first, all Host adapters attempted, then IPC disable; Remote/Isolated runs untouched; durable opt-in clears.
- **Failure and recovery assertions:** failed interrupt prevents teardown; partial adapter rejection is settled; retry works; no orphan lease/daemon.
- **Accessibility assertions:** modal trap/Escape/focus restoration; pending state textual under reduced motion.
- **Security and privacy assertions:** only owned private daemon/stage removed; no broad process kill/path cleanup.
- **Cleanup / reset:** re-enable only if subsequent suite requires it; stop fixtures.
- **Automation mapping:** `server/index.test.ts`, `electron/cua-linux-runtime.test.mjs`, `electron/cua-linux-bundle.test.mjs`.
- **Evidence to retain:** call order, process list, capability events, Gate recording.

### WB-RACE-001 — Status, polling, SSE, and reconnect never show stale ownership or frames

- **Priority:** P0
- **Execution:** Manual — executable with deterministic network fixture; automation required before release
- **Platforms:** all desktop platforms
- **Surface / route:** panel status/control/screenshot effects and resumable SSE
- **Controls / triggers:** switch operator/surface/profile, hide page, open viewer, disconnect/reconnect, reload renderer
- **Preconditions and fixtures:** delayed responses tagged by operator/run; SSE screen/control sequence; fake clock.
- **Steps:** delay Rivet requests, switch to Cairn, release delayed responses; take control during delayed GET; disconnect SSE and replay; open/close viewer while poll scheduled; hide/show page.
- **Expected visible output:** only current operator/surface frame/status; newer SSE ownership wins; no poll while hidden/viewer open; reconnect resumes without duplicate flicker.
- **Expected persisted / network output:** effect cleanup aborts/ignores stale results; no overlapping screenshot request; busy cadence 3/4s as applicable, idle 30s; replay cursor monotonic.
- **Failure and recovery assertions:** stale GET cannot release/hide a live hold; old screenshot cannot overwrite SSE/new operator; server restart yields actionable retry.
- **Accessibility assertions:** live regions announce meaningful transitions once, not every poll.
- **Security and privacy assertions:** no cross-operator frame, URL, profile, or help reason.
- **Cleanup / reset:** clear fake clock/timers, release controls, close viewers, assert zero in-flight requests.
- **Automation mapping:** `server/index.test.ts` resumable event stream, `src/components/ComputerPanel.tsx`; add component/E2E coverage if absent.
- **Evidence to retain:** timestamped request/event/store timeline and screen recording.

### WB-SEC-001 — Container/VPS readiness is a security verdict, not process liveness

- **Priority:** P0
- **Execution:** Automated — passing; Manual inspect confirmation
- **Platforms:** Docker/Podman/Windows WSL/VPS
- **Surface / route:** every status/readiness and create/provision path
- **Controls / triggers:** Re-check, Create, Start, Replace, provision
- **Preconditions and fixtures:** permutations of privileged mode, host namespaces, extra caps, public ports, unexpected mount, wrong labels/image id/driver/base, cross-target label, unsafe persistence/network, failed health.
- **Steps:** apply each single defect to an otherwise-valid target; poll; try Start/Open; replace with valid target.
- **Expected visible output:** never Ready; exact bounded problem; Start/Open disabled or fails; Replace path only where owned.
- **Expected persisted / network output:** status `ready=false`; no viewer URL handed off; run args enforce 4GB, 2CPU, 512 pids, minimal caps, loopback, exact durable mount/labels.
- **Failure and recovery assertions:** repairing all facts transitions to Ready after desktop health; stale mutable tag still rejected by image id/labels.
- **Accessibility assertions:** problem is text/icon, not color-only.
- **Security and privacy assertions:** no host mount/namespace/public port/unowned removal/cross-target attachment.
- **Cleanup / reset:** remove defective QA targets explicitly.
- **Automation mapping:** `server/container-computer.test.ts`, `server/vps-computer.test.ts`.
- **Evidence to retain:** defect matrix with status body and inspect JSON.

## Cross-cutting interaction and layout pass

Run the following assertions against every rendered control ID in WB-PANEL, WB-SETUP, WB-HOST, WB-BUI, and WB-SPLIT:

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| WB-XCUT-001 | All controls | Keyboard/focus | Mouse unplugged | Tab/Shift+Tab/Enter/Space/arrows/Escape | Logical order, one visible focus, native view never traps focus unexpectedly, pressed/switch/select semantics correct | Disabled controls skipped; closing full surface restores launcher | Focus recordings/accessibility tree | P1 |
| WB-XCUT-002 | Gates/native overlays | Modal behavior | Each Gate with native view behind | Open, cycle, Escape, cancel, confirm | Native views hidden, alertdialog labelled/described/modal, initial cancel focus, trapped Tab, restored focus | 390 dialog scrolls; background cannot click/type; confirm only once | Electron video/tree | P0 |
| WB-XCUT-003 | Status/error/live regions | Screen reader | Every loading/success/error/hold/help state | Trigger transitions | Status/polite/alert roles announce concise state once; technical detail discoverable | Polls/spinners do not spam; color never sole signal | VoiceOver/NVDA/Orca logs | P1 |
| WB-XCUT-004 | Responsive panel | 390/768/1440 | Long names/errors/profile/path | Resize/zoom 200% | Critical actions reachable, headers use sr-only labels when compact, no clipped details/overflow; touch controls at least 36px and adequate spacing | Native view bounds match visual host after scroll/resize | Screenshots/bounds overlay | P1 |
| WB-XCUT-005 | Reduced motion | OS preference | Every spinner/panel transition | Toggle preference | Pending text/icon remains; `motion-safe` animation stops; no vestibular motion | Functional timing/state unchanged | Video/computed styles | P1 |
| WB-XCUT-006 | Restart/reconnect | App/server/native/runtime | Pending/held/streaming states | Crash/restart each layer | Truth reconciles from persisted config/native state/API; no duplicated mutation, leaked viewer/tunnel/stream, or permanent pause | Partial create/remove/open exposes recovery instead of auto-destructive retry | Process/network/store trace | P0 |
| WB-XCUT-007 | Secrets and local boundaries | Every output channel | Seed recognizable canary tokens/URLs/paths | Exercise success/error/export/log/transcript | Secrets confined to OS credential/main/native handoff; browser host/VPS/noVNC loopback; public UI/tool output scrubbed | Search artifacts finds no canary except explicitly encrypted/test-secret store | Redaction scan and port bind report | P0 |

## Automation commands and evidence map

Run from the Helmryth root in a clean temporary data directory. Record exact commit, OS, architecture, runtime versions, Electron version, and command exit codes.

```sh
pnpm exec vitest run \
  src/lib/desktop.test.ts \
  src/lib/local-computer.test.ts \
  src/lib/local-vm-workspace.test.ts \
  src/lib/vps-computer.test.ts \
  server/index.test.ts \
  server/computer-control.test.ts \
  server/computer-observation.test.ts \
  server/computer-proxy.test.ts \
  server/container-computer.test.ts \
  server/local-computer.test.ts \
  server/local-vm-idle.test.ts \
  server/local-vm-lease.test.ts \
  server/remote-computer.test.ts \
  server/vps-computer.runner.test.ts \
  server/vps-computer.test.ts \
  server/vps-container-mcp.test.ts \
  server/vps-routing.test.ts \
  server/browser-connection.test.ts \
  server/drivers/browser-proxy.test.ts \
  server/box-errors.test.ts \
  server/box-lifecycle.test.ts \
  server/box-provision.test.ts \
  server/box-trial.test.ts

node --test \
  electron/browser-snapshot.test.mjs \
  electron/browser-surface.test.mjs \
  electron/cua-connection.test.mjs \
  electron/cua-linux-bundle.test.mjs \
  electron/cua-linux-runtime.test.mjs \
  electron/cua-linux.test.mjs \
  electron/desktop-viewer.node-test.mjs \
  electron/desktop-workspace.node-test.mjs \
  electron/capabilities.test.mjs \
  electron/screen-preview.test.mjs

pnpm typecheck
pnpm build
node scripts/check-contrast.mjs
```

Existing automation is strong for route policy, runtime hardening, leases, browser native behavior, and proxy tool contracts. It does **not** replace the required Electron end-to-end proof for component buttons, focus restoration, native-view overlay alignment, macOS TCC, Linux portals, real Docker/Podman/Windows mounts, real SSH forwarding, or responsive rendered states. Those cases remain `Manual — executable` until a named E2E test is added and passing.

### Authoring verification snapshot — 2026-08-30

- Focused Vitest execution for `src/lib/local-vm-workspace.test.ts`, `server/computer-control.test.ts`, `server/container-computer.test.ts`, `server/drivers/browser-proxy.test.ts`, and `electron/browser-surface.test.mjs`: **5 files, 93 tests passed**.
- Native Node execution for `electron/desktop-workspace.node-test.mjs` and `electron/desktop-viewer.node-test.mjs`: **16 tests passed**.
- Harness route execution for `server/index.test.ts`: **1 file, 112 tests passed**.
- Document integrity: **213 definitions, 213 distinct IDs, 0 duplicates; 205 compact rows, 0 malformed rows; 63 exact source/test references, 0 missing; 0 placeholder-pattern findings**.

This snapshot proves the named automated boundaries on the authoring revision. It does not pre-mark the manual platform, visual, permission, container, VPS, or live-provider cases as passed.

## Release sign-off record

The executor must append a signed run record in the PR or release evidence system, not in this static plan. It must contain: commit SHA, environment matrix, case IDs executed, pass/fail/block reason, defect links, retained artifact paths/hashes, secret-scan result, container/VPS cleanup proof, and final approver. Any P0 failure blocks release. Any waived P1 must name an owner, expiry, user impact, and fail-closed mitigation.
