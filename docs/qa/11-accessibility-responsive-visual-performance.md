# Accessibility, responsive, visual, and performance QA

This document is the cross-cutting quality contract for every rendered Helmryth surface. It does not replace the feature-domain documents in `01` through `06`; it binds them together with shared accessibility, responsive, visual-identity, motion, and runtime-performance proof so a release cannot pass while one screen family remains functionally correct but operationally unshippable.

## Scope, census, and sources

| Inventory | Count / source |
|---|---|
| Renderer entrypoints | `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/sigil-preview.tsx`, `src/sigil-preview.css` |
| Primary component surfaces | `79` component files under `src/components` spanning onboarding, roster, workstreams, settings, operations, Workbenches, voice, mobile, and update states |
| Docs-facing web surface | `apps/docs` Next.js app, plus public marketing and help copy consumed from root `docs/` |
| Required viewport set | `390x844`, `768x1024`, `1440x900`, plus browser zoom `200%` on desktop |
| Light-theme contract | Helmryth is light-first only; dark fallback, inherited legacy palette, or unstyled flashes fail release (`DESIGN.md`, `src/lib/skins.ts`, `src/styles.css`) |
| Existing automated evidence | `pnpm check:contrast`, `src/lib/skins.test.ts`, `src/lib/desktop.test.ts`, `src/lib/bottom-follow.test.ts`, `src/lib/inspector.test.ts`, `src/lib/local-computer.test.ts`, `src/lib/screen-preview.test.ts`, `src/components/*` tests covering modal state, rename, engine setup, phone status, routines page, and cards |

## Executed browser evidence on August 30, 2026

The following Playwright screenshot captures exist under `output/playwright` and were reviewed as concrete browser-visible evidence for this chapter:

- `onboarding-1440.png`
- `workstream-1440.png`
- `operations-map-1440.png`
- `cadences-1440.png`
- `webhooks-1440.png`
- `capabilities-1440.png`
- `system-1440.png`
- `operator-workbench-1440.png`
- `trace-1440.png`
- `mobile-trace-390.png`
- `mobile-roster-390.png`

This executed browser pass also reported `0` console errors and `0` console warnings.

What these captures prove:

- the light Helmryth visual system is present across the reviewed routes;
- the `1440px` layout is materially exercised for onboarding, direct workstream, Operations, Cadences, Webhooks, Capabilities, System, Workbench, and Trace;
- the `390px` layout is materially exercised for the roster drawer and the Trace composition;
- the reviewed browser run stayed clean at the console level.

What these captures do not prove on their own:

- screen-reader announcement quality;
- keyboard-only traversal and focus trap correctness across all overlays;
- reduced-motion behavior;
- `200%` zoom behavior;
- packaged desktop, iOS, Android, or native-view behavior.

## Browser-visible review notes from the executed screenshots

| ID | Screenshot evidence | Observation | Status effect |
|---|---|---|---|
| `AX-OBS-001` | `mobile-roster-390.png` | The roster drawer remains legible at `390px`; search, primary roster row, footer routes, profile row, and dismiss control are all visible within the mobile composition. | Supports `AX-003` and `AX-RSP-002`; does not replace keyboard or screen-reader proof. |
| `AX-OBS-002` | `workstream-1440.png` | The direct workstream composition at `1440px` keeps roster, transcript, opening brief, and composer visible without horizontal overflow in the captured state. | Supports `AX-004` and `AX-RSP-003`; does not prove dynamic transcript growth or keyboard traversal. |
| `AX-OBS-003` | `system-1440.png` | The Helmryth System modal renders with readable two-column composition and visible close control at `1440px`. | Supports `AX-006`; does not prove focus containment or `200%` zoom. |
| `AX-OBS-004` | `operator-workbench-1440.png` | The Workbench side panel remains readable at `1440px`, with configuration, execution-surface controls, and cadence controls visible in one capture. | Supports `AX-008`; does not prove native-view handoff or held-control transitions. |
| `AX-OBS-005` | `trace-1440.png` | The Trace panel empty state is visible and readable beside the active workstream at `1440px`. | Supports `AX-007` and `AX-008`; does not prove populated-trace density. |
| `AX-OBS-006` | `mobile-trace-390.png` | The `390px` Trace capture keeps the close button, tab strip, empty-state copy, and composer visible, but also shows a partial left-edge artifact from the underlying workstream composition. This is review evidence, not a narrow-width Trace pass. | Record as open review evidence against `AX-RSP-004` and `AX-007`; do not mark mobile Trace composition fully passed from this screenshot alone. |

## Cross-surface invariants

Every rendered case in `01` through `06` must additionally satisfy the following:

1. Every visible action is reachable by pointer and keyboard, has a perceivable accessible name, and exposes state with text or semantics rather than color alone.
2. No critical control, heading, card, message, drawer, dialog, or footer action clips or requires horizontal page scrolling at `390px`.
3. Focus always enters overlays, remains trapped while the overlay is modal, and returns to the opener on close.
4. Reduced-motion users still receive status and progress through text, shape, or iconography; decorative movement is optional and must never carry sole meaning.
5. Light-theme tokens, fonts, sigils, empty states, live regions, and error copy stay Helmryth-branded and free of pre-rebrand vocabulary.
6. Search, transcript paging, SSE hydration, screen-preview refresh, mobile-state refresh, and update-state polling do not produce layout thrash, duplicate live announcements, or stale focus jumps.
7. Renderer errors fail visibly and recoverably. No raw stack trace, JSON blob, or console-only failure is acceptable for a user-facing state.

## Surface matrix

| ID | Surface family | Required assertions | Existing evidence | Priority |
|---|---|---|---|---|
| `AX-001` | App bootstrap, first paint, and shell frame | Initial paint is light-only, branded, and free of unstyled flash; focus lands on the first meaningful control; native unread badge updates never block the renderer | `src/lib/skins.test.ts`, `01-desktop-shell-onboarding-roster.md` `SH-LIFE-*` | `P0` |
| `AX-002` | Onboarding identity, engines, input, and mobile steps | Step labels, examples, buttons, skip paths, validation, and progress indicators have names/states; error copy is inline and announced; CTA rows remain visible at `390px` without overlap | `01-desktop-shell-onboarding-roster.md` `OB-*`, `src/components/EngineSetup.test.ts`, `src/lib/phone-setup.test.ts`, executed screenshot `output/playwright/onboarding-1440.png` | `P0` |
| `AX-003` | Sidebar, roster, command palette, search, and archive flows | Drawer open/close, dense modes, search hits, archive dialogs, context menus, and command palette all preserve focus order and screen-reader clarity; icon-only navigation still has names | `01-desktop-shell-onboarding-roster.md` `SH-*`, `RS-*`, `SR-*`, `CP-*`, executed screenshot `output/playwright/mobile-roster-390.png` | `P0` |
| `AX-004` | Workstream transcript, composer, approvals, secret cards, connector cards, and reactions | Message grouping, reply quotes, approval states, attachment chips, composer errors, and busy states are announced without over-speaking; keyboard traversal never skips inline actions | `02-workstreams-crews-runs-gates.md`, `src/components/ApprovalCard.test.ts`, `src/lib/composer-attachments.test.ts`, `src/lib/replies.test.ts`, executed screenshot `output/playwright/workstream-1440.png` | `P0` |
| `AX-005` | Crews, runs, Gates, and routine cards | Group membership controls, routine status dots, schedule summaries, and Gate affordances use text plus semantic state; restore/cancel/deny paths preserve focus and live-region behavior | `02-workstreams-crews-runs-gates.md`, `04-operations-cadences-webhooks-capabilities-methods-trace.md`, `src/components/RoutineRunCard.test.ts`, `src/components/RoutinesPage.test.ts` | `P0` |
| `AX-006` | System, settings, engines, sigils, keys, diagnostics, and telemetry controls | Modal sections, provider rows, form controls, secure-key affordances, and diagnostics exports expose state changes and error handling clearly; secret values are never re-read into visible text after save | `03-system-settings-engines-identity.md`, `09-security-privacy-data-migrations.md`, `electron/diagnostics.test.mjs`, executed screenshot `output/playwright/system-1440.png` | `P0` |
| `AX-007` | Operations map, Cadences, Webhooks, Capabilities, Methods, and Trace | Dense cards and timelines remain readable at all target widths; empty/loading/error states differ clearly; badges and connection states are not color-only | `04-operations-cadences-webhooks-capabilities-methods-trace.md`, `08-cloud-registry-conduit-mcp.md`, executed screenshots `output/playwright/operations-map-1440.png`, `output/playwright/cadences-1440.png`, `output/playwright/webhooks-1440.png`, `output/playwright/capabilities-1440.png`, `output/playwright/trace-1440.png`, review capture `output/playwright/mobile-trace-390.png` | `P1` |
| `AX-008` | Browser, Host, Isolated, Local VM, Remote, Box, VPS, and split Workbenches | Embedded viewers, panes, overlays, and held-control states preserve a visible controller and clear fail-closed copy; keyboard escape routes remain intact even when a native surface steals pointer focus | `05-workbenches-browser-host-isolated-remote.md`, `src/lib/local-vm-workspace.test.ts`, `src/lib/vps-computer.test.ts`, `electron/desktop-viewer.node-test.mjs`, executed screenshot `output/playwright/operator-workbench-1440.png` | `P0` |
| `AX-009` | Voice, mobile, Android, iOS, and pairing states | Microphone prompts, transcription state, pairing status, expiry, QR/manual-code fallbacks, and device revocation remain readable, named, and recoverable on small screens | `06-voice-mobile-relay-android-ios.md`, `src/lib/push-to-talk.test.ts`, `src/lib/live-activity.test.ts`, `companion/test/control.test.ts` | `P0` |
| `AX-010` | Update banner and release-status copy | Idle, checking, downloading, downloaded, and error states are visible and announced without requiring animation; updater absence in dev is silent and fail-closed | `01-desktop-shell-onboarding-roster.md` `UP-*`, `electron/updater-coordinator.node-test.mjs`, `electron/update-channel.node-test.mjs` | `P0` |
| `AX-011` | Docs site and public help copy | Navigation, MDX content, code blocks, heading hierarchy, skip targets, and anchor links work at desktop and mobile widths; no legacy product wording remains in public docs | `pnpm docs:build`, `docs/qa/12-automated-suite-environments-and-evidence.md`, `README.md`, `docs/*.md`, `apps/docs` build checks | `P1` |

## Keyboard, focus, and screen-reader contract

| ID | Controls / triggers | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|
| `AX-KB-001` | Top-level navigation, footer actions, roster rows, and primary CTAs | Fresh shell and populated shell | Traverse with `Tab`, `Shift+Tab`, arrow keys where listbox/dialog patterns apply, `Enter`, and `Space` | Focus order follows visual order; every actionable item exposes a visible focus treatment; activation semantics match the visible control type | Hidden or disabled controls must not receive focus; icon-only controls must announce their purpose | Manual accessibility tree plus owning domain cases | `P0` |
| `AX-KB-002` | Dialogs, drawers, command palette, context menus, and settings modal | Open any modal or drawer at all three widths | Use keyboard only to open, interact, and close | Focus moves into the top-most overlay, remains contained, and returns to the opener after close | `Escape` closes only the active overlay; background controls never become tabbable | `01` through `06` modal cases, manual a11y snapshots | `P0` |
| `AX-KB-003` | Transcript and activity regions | Workstream with messages, runs, cards, and loading states | Navigate through message actions, replies, reactions, and card buttons | Reading order remains coherent; live updates append without yanking focus away from the user | Reconnect, replay, or reaction updates must not cause the virtual cursor to jump | `02-workstreams-crews-runs-gates.md`, SSE/manual traces | `P0` |
| `AX-KB-004` | Embedded or native-adjacent surfaces | Browser Workbench, desktop viewer, Local VM workspace, mobile pairing controls | Move focus into and out of embedded views using keyboard and close affordances | A perceivable path exists back to the owning app chrome; close/dismiss actions remain keyboard reachable | A native or embedded focus trap that strands the user is a release blocker | `05-workbenches-browser-host-isolated-remote.md`, manual packaged-app proof | `P0` |

## Responsive and layout contract

| ID | Surface / route | Layout assertions at `390`, `768`, `1440`, and `200%` zoom | Evidence | Priority |
|---|---|---|---|---|
| `AX-RSP-001` | Onboarding and shell chrome | No clipped CTAs, no overlapping brand mark/tagline, no off-screen close buttons, no footer collision with virtual keyboard-sized viewports | `01` onboarding and shell screenshots, executed `output/playwright/onboarding-1440.png` | `P0` |
| `AX-RSP-002` | Sidebar and drawer | Drawer covers content cleanly at `390`, fixed rail remains usable at larger widths, and dense/sigils-only modes do not remove discoverability | `01` roster cases, executed `output/playwright/mobile-roster-390.png` | `P0` |
| `AX-RSP-003` | Transcript and composer | Composer remains fully reachable, attachment chips wrap, code blocks scroll within themselves, and approval cards do not force page-level horizontal scroll | `02` transcript/composer cases, executed `output/playwright/workstream-1440.png` | `P0` |
| `AX-RSP-004` | Operations, Capabilities, and Trace surfaces | Card grids reflow without clipped badges or orphaned action bars; long provider names and slugs truncate safely with accessible full text | `04` operations cases, executed `output/playwright/operations-map-1440.png`, `output/playwright/capabilities-1440.png`, `output/playwright/trace-1440.png`; `output/playwright/mobile-trace-390.png` is review evidence only because of the observed left-edge composition artifact | `P1` |
| `AX-RSP-005` | Workbench and viewer surfaces | Split layouts preserve one obvious primary pane, viewer close controls remain visible, and pane handoff copy does not wrap into unreadable stacks | `05` Workbench cases, executed `output/playwright/operator-workbench-1440.png` | `P0` |
| `AX-RSP-006` | Mobile, voice, and pairing surfaces | QR/manual-code fallback, device cards, waveform or speech status, and revocation controls remain usable on phone-sized layouts | `06` mobile/voice cases | `P0` |
| `AX-RSP-007` | Docs site | MDX prose, tables, callouts, and code blocks remain navigable on mobile; no table is the sole copy path for a critical instruction without horizontal fallback | `pnpm docs:build` plus manual browser checks | `P1` |

## Visual identity and content integrity

| ID | Surface | Expected result | Evidence | Priority |
|---|---|---|---|---|
| `AX-VIS-001` | Theme and token application | All surfaces use Helmryth light tokens, type families, and sigil/mark usage defined by `DESIGN.md`; no inherited dark treatment appears during launch or route changes | `DESIGN.md`, `src/styles.css`, `src/lib/skins.test.ts`, executed screenshots across `output/playwright/*.png`, manual cold-start recording | `P0` |
| `AX-VIS-002` | Contrast and non-text cues | Text contrast stays `>= 4.5:1`; focus rings and meaningful UI strokes stay `>= 3:1`; badge-only states also expose text, shape, or icon differentiation | `pnpm check:contrast` and owning domain screenshots | `P0` |
| `AX-VIS-003` | Vocabulary and naming | All user-facing copy, alt labels, notifications, diagnostics headings, and updater labels use Helmryth vocabulary; no inherited pre-Helmryth product residue remains | `pnpm check:brand`, manual copy audit across `01` through `06`, `README.md`, `docs/*.md` | `P0` |
| `AX-VIS-004` | Empty/loading/error/success differentiation | Empty states, loaders, transient banners, denied states, and recoveries are visually distinct and cannot be confused when color is removed or screen capture is grayscale | Domain screenshots, `UP-*`, `OB-*`, `WS-*`, `WB-*` cases | `P1` |

## Motion and reduced-motion contract

| ID | Surface | Preconditions | Action | Expected result | Evidence | Priority |
|---|---|---|---|---|---|---|
| `AX-MOT-001` | Drawer, modal, command palette, and update banner transitions | `prefers-reduced-motion: no-preference` and `reduce` | Open and close the surface in both modes | Motion is brief and meaningful when allowed, and meaning remains intact with reduced motion enabled | Manual browser session and owning domain cases | `P1` |
| `AX-MOT-002` | Search refresh, SSE hydration, transcript follow, and live status polling | Populated shell with incoming updates | Trigger incoming events, search reruns, and mobile/update polling | New content appears without scroll whiplash, repeated announcements, or skeleton loops; reduced motion does not suppress textual status | `src/lib/bottom-follow.test.ts`, `src/lib/live-events.test.ts`, manual replay traces | `P0` |
| `AX-MOT-003` | Screen preview, Workbench frame refresh, and Android/iOS previews | Device or local preview available | Repeatedly refresh previews while interacting elsewhere in the shell | Frame updates do not steal focus, and stale-frame fallback remains obvious when motion is reduced or capture is unavailable | `src/lib/screen-preview.test.ts`, `electron/browser-snapshot.test.mjs`, `electron/screen-preview.test.mjs` | `P1` |

## Performance and resilience contract

| ID | Surface / probe | Preconditions | Action | Expected result | Evidence | Priority |
|---|---|---|---|---|---|---|
| `AX-PERF-001` | Cold launch to first actionable shell | Isolated data dir, first-use and populated fixtures | Cold-launch the renderer in dev and packaged builds | Renderer reaches a usable first screen without long blank intervals, repeated bootstrap loops, or double event subscriptions | `01` shell lifecycle cases, packaged smoke, manual timing notes | `P0` |
| `AX-PERF-002` | Transcript append and follow behavior | Long transcript plus incoming messages | Send consecutive messages, approvals, and reactions | The transcript remains responsive; bottom-follow behavior does not oscillate; manual scroll position is respected | `src/lib/bottom-follow.test.ts`, `src/lib/turn-tail.test.ts`, `02` workstream cases | `P0` |
| `AX-PERF-003` | Large roster, palette, and search | `S3-large-roster` fixture from `01` | Filter, open palette, and resolve search results repeatedly | Search and palette ranking stay stable and interactive; no unbounded rerender or input lag is introduced by the large fixture | `01` `SR-*` and `CP-*`, `src/lib/palette-rank.test.ts`, `src/lib/sidebar-preferences.test.ts` | `P1` |
| `AX-PERF-004` | Operations and Trace timelines | Populated Cadences, Webhooks, Capabilities, and Trace cards | Switch filters and refresh state rapidly | Dense cards remain readable and no async refresh paints stale data over newer results | `04` operations cases, manual network throttling | `P1` |
| `AX-PERF-005` | Workbench frame and control updates | Viewer/control states changing under load | Acquire/release control, refresh browser/local preview, and reconnect the owning surface | Control state remains authoritative, one controller is always clear, and reconnect does not duplicate status widgets | `05` Workbench cases, `server/computer-control.test.ts`, `electron/desktop-workspace.node-test.mjs` | `P0` |
| `AX-PERF-006` | Browser runtime cleanliness during reviewed route sweep | Reviewed Playwright browser sweep over onboarding, workstream, Operations, Cadences, Webhooks, Capabilities, System, Workbench, Trace, and mobile roster/Trace | Complete the route sweep and inspect console output | Reviewed browser run records `0` console errors and `0` console warnings while producing the named screenshot set | Executed screenshot set under `output/playwright`, browser console summary from the same run | `P1` |

## Still-unexecuted cross-surface evidence

The following quality gates remain explicitly unexecuted for this chapter as of August 30, 2026:

- screen-reader transcript capture for onboarding, System, direct workstream, crew workstream, Workbench gates, and mobile pairing;
- reduced-motion route sweep;
- `200%` zoom route sweep;
- packaged desktop and device-native evidence for macOS, Windows, Ubuntu, iOS, and Android;
- populated `390px` Trace proof without the left-edge composition concern seen in `mobile-trace-390.png`.

## Expanded scenarios

### `AX-SCN-001` — keyboard-only first-use to first completed run

- **Priority:** `P0`
- **Execution:** `Manual — executable`
- **Platforms:** `browser development shell`, `macOS packaged app`, `Windows packaged app`, `Ubuntu/Xorg packaged app`
- **Surface / route:** onboarding, roster, first operator chat, and first completed run
- **Controls / triggers:** keyboard only, including `Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`, and command shortcuts
- **Preconditions and fixtures:** isolated data dir, `S0-first-use`, one available engine, optional denied microphone path
- **Steps:**
  1. Complete onboarding entirely with keyboard controls.
  2. Open the first operator workstream and send a direction.
  3. Resolve any approval or error card that appears.
  4. Reopen System, Capabilities, and the command palette, then close each and return to the transcript.
- **Expected visible output:** every stage is reachable without pointer input; focus never disappears; transcript, cards, and overlays announce state and restore focus correctly
- **Expected persisted / network output:** profile/config writes occur once; unread and route state persist after reload; no duplicate send or ghost overlay remains
- **Failure and recovery assertions:** any pointer-only control, trapped focus, or ambiguous live status is a release blocker
- **Accessibility assertions:** names, roles, states, live regions, and focus visibility remain intact at all target widths
- **Security and privacy assertions:** no secret or personal text is exposed solely through a tooltip or hidden off-screen helper
- **Cleanup / reset:** delete isolated data and revoke any paired device created during the run
- **Automation mapping:** `01`, `02`, `03`, and `06` domain cases
- **Evidence to retain:** screen recording at `390px` and `1440px`, accessibility snapshots, and redacted network trace

### `AX-SCN-002` — reduced-motion and low-vision audit across active shells

- **Priority:** `P0`
- **Execution:** `Manual — executable`
- **Platforms:** `browser development shell`, `desktop app`
- **Surface / route:** onboarding, roster, transcript, operations, Workbench, mobile drawer, update banner
- **Controls / triggers:** system reduced-motion setting, high zoom, contrast check, grayscale snapshot review
- **Preconditions and fixtures:** populated shell with active updates, one pending Gate, one update state, and one Workbench status card
- **Steps:**
  1. Enable `prefers-reduced-motion: reduce` and set browser zoom to `200%`.
  2. Repeat route changes, overlay opens, search, transcript append, and update-state changes.
  3. Capture grayscale or low-saturation screenshots for the same states.
- **Expected visible output:** all state changes remain understandable without motion or hue; no clipped text appears at `200%` zoom
- **Expected persisted / network output:** no extra writes, event duplication, or stale replay caused by the setting changes
- **Failure and recovery assertions:** if meaning depends on animation or color alone, the owning case fails
- **Accessibility assertions:** live regions remain useful but not noisy; screen-reader names still align with visible copy
- **Security and privacy assertions:** no obscured text becomes the only place a capability URL, local path, or secret status is explained
- **Cleanup / reset:** restore normal motion and zoom settings
- **Automation mapping:** `pnpm check:contrast` plus owning domain cases
- **Evidence to retain:** contrast output, zoomed screenshots, and reduced-motion recordings

### `AX-SCN-003` — large-fixture resilience without layout or interaction collapse

- **Priority:** `P1`
- **Execution:** `Manual — executable`
- **Platforms:** `browser development shell`, `desktop app`
- **Surface / route:** large roster, search, command palette, transcript, operations map
- **Controls / triggers:** rapid filter changes, repeated palette open/close, transcript scroll/follow, operations refresh
- **Preconditions and fixtures:** `S3-large-roster` plus long transcripts and active operations data
- **Steps:**
  1. Filter the roster and clear it repeatedly.
  2. Open the command palette, move selection, and land several search hits.
  3. Scroll a long transcript away from the tail, append new activity, and return to bottom.
  4. Switch to Operations and Trace while updates are still arriving.
- **Expected visible output:** no collapsed layout, unreadable list rows, or stuck loading indicators; selected items remain obvious
- **Expected persisted / network output:** local filters remain local-only; async results never overwrite newer state
- **Failure and recovery assertions:** stale-result paints, list jumps, or impossible selection state fail the owning surface
- **Accessibility assertions:** filtered results and async loads expose a perceivable busy/empty state
- **Security and privacy assertions:** preview snippets and traces remain redacted even under dense layouts
- **Cleanup / reset:** clear the filter and stop synthetic updates
- **Automation mapping:** `01` `SR-*` and `CP-*`, `02` transcript cases, `04` operations cases
- **Evidence to retain:** before/after screenshots and browser performance trace for the highest-latency run
