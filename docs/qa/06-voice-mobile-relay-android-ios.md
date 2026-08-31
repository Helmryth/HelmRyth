# Voice, Mobile Relay, Android, and iOS QA

Last reviewed: 2026-08-30

This document owns the QA contract for Helmryth's voice surfaces, Helmryth Mobile pairing and relay, the companion sidecar control and device route boundary, Android USB workbench control, and the native iOS companion. It is derived from the current desktop renderer, Electron bridge, companion sidecar, `CompanionCore` package, and iOS app sources rather than from product copy alone.

## Scope and evidence

- Desktop voice UI: `src/components/CallView.tsx`, `GroupCallView.tsx`, `SpeakButton.tsx`, `src/lib/call.ts`, `src/lib/group-call.ts`, `src/lib/voice-gate.ts`
- Desktop mobile setup UI: `src/components/PhoneSetupFlow.tsx`, `CompanionSection.tsx`, `ConnectionDetail.tsx`, `SidebarPhoneButton.tsx`
- Desktop Android workbench: `src/components/AndroidDevicePanel.tsx`
- Electron bridge and native helpers: `electron/speech.mjs`, `electron/skill-recorder.mjs`, `electron/companion-entry.mjs`, `electron/companion-origin-gateway.mjs`, `electron/companion-account-service.mjs`
- Companion sidecar: `companion/src/routes.ts`, `control.ts`, `proxy.ts`, `devices.ts`, `endpoints.ts`
- iOS app and widgets: `ios/App/*.swift`, `ios/Widgets/HelmrythWidgets.swift`, `ios/Package.swift`
- Existing automated proof: `src/components/*.test.ts`, `src/lib/*.test.ts`, `companion/test/*.test.ts`, `electron/*test.mjs`, `ios/Tests/CompanionCoreTests/*.swift`

## Fresh verification snapshot

Execution in this review is limited to code-level and package-level checks that can run on this machine without real phones, Apple signing, or packaged desktop artifacts.

| Check | Purpose | Result |
|---|---|---|
| `pnpm exec vitest run src/lib/call.test.ts src/lib/group-call.test.ts src/lib/companion-pairing.test.ts src/lib/skill-recorder.test.ts src/components/CallView.test.ts src/components/CompanionSection.test.ts src/components/ConnectionDetail.test.ts src/components/SidebarPhoneButton.test.ts` | Desktop voice/mobile component and pure logic regression proof | Passed: 8 files, 83 tests |
| `pnpm exec vitest run companion/test/routes.test.ts companion/test/proxy.test.ts companion/test/proxy-response.test.ts companion/test/devices.test.ts companion/test/endpoints.test.ts companion/test/connected-devices.test.ts companion/test/control.test.ts companion/test/upstream-failure.test.ts companion/test/mdns.test.ts companion/test/origin.test.ts companion/test/ports.test.ts companion/test/wire.test.ts companion/test/advertise-watch.test.ts` | Sidecar route policy, proxy, pairing, device registry, endpoint refresh, discovery | Passed: 13 files, 208 tests |
| `pnpm exec vitest run electron/companion-entry.test.mjs electron/companion-origin-gateway.test.mjs electron/companion-account-service.test.mjs electron/skill-recorder.test.mjs` | Electron bridge, hosted gateway, relay account, recorder compiler | Passed: 4 files, 44 tests |
| `swift test` from `ios/` | `CompanionCore` parsing, failover, pairing, SSE, onboarding, dictation logic | Blocked by local Apple toolchain setup: active developer directory is `/Library/Developer/CommandLineTools`; `xcodebuild` is unavailable and `swift test` fails with `no such module 'XCTest'` |

The failed `node --test` attempt against Electron `.mjs` suites was a harness mismatch during this review, not a product regression. Those files are Vitest suites and were rerun successfully under `pnpm exec vitest run`.

## Coverage summary

- Compact cases in this file: 126
- Breakdown: 16 desktop voice, 20 desktop mobile/relay, 16 sidecar/control, 9 Android USB workbench, 65 iOS companion and widget cases
- Expanded end-to-end scenarios in this file: 12
- Explicit route and capability boundaries called out: 43
- iOS control-bearing Swift files ledgered in this document: 23 of 23 currently detected under `ios/App` and `ios/Widgets`

## Surface inventory

| Surface | Route / owner | Notes |
|---|---|---|
| Operator voice line button | Bot workstream header, desktop renderer | Opens only when dictation is available and voice is configured |
| Crew voice line button | Crew workstream header, desktop renderer | Requires every crew operator to have a voice |
| Voice line overlay | Modal voice surface, desktop renderer | Half-duplex mic, narration, spoken gate decisions, `Escape` closes |
| Message speak button | Per-message transcript action | Disabled but visible without voice config |
| Mobile status button | Sidebar global control | Opens settings section `companion`; status is live-stream aware |
| Mobile setup flow | System -> Helmryth Mobile | Intro, sign-in, provisioning, QR/manual code, success |
| Pairing trace and recovery | Desktop settings details | Control-plane toggles, reveal/copy routes, relay sign-out, fallback pairing, revoke gate |
| Companion control page | `GET /`, `GET /state`, `POST/DELETE /pairing`, `PUT /hosted-endpoint`, `POST/DELETE /devices/:id/cloud-desktop`, `DELETE /devices/:id` | Loopback-only; browser origin checked |
| Device-facing companion API | `/api/*` on sidecar | Default-deny allowlist in `companion/src/routes.ts` |
| Android USB workbench | Desktop Computer panel | Polls ADB state and frames; input capture is explicit |
| iOS onboarding | Welcome, unpaired home, notification education | Native-only flows before or after pairing |
| iOS pairing | QR, nearby discovery, manual address + code, confirmation, connect | Consent screen required before redemption |
| iOS chats and updates | Roster, workstream, Updates sheet, Tasks/Routines, Capabilities, Settings | Foreground/resume/reconnect model |
| iOS remote workbench | `ComputerView`, `CloudDesktopBrowser` | Screen watch is view-scoped; full control is separate and explicit |
| Widgets and Live Activities | `HelmrythWidgets.swift`, `LiveActivities.swift` | Foreground-driven updates; no push path yet |

## Compact control cases

### Desktop voice surfaces

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-VOICE-001 | Bot workstream header | Voice line icon button | Desktop capabilities still loading | Focus the button | `aria-label` says availability is being checked; inactive button does not start a call | No call starts before capability resolution | Source: `CallTargetButton`; manual keyboard check | P1 |
| VM-VOICE-002 | Bot workstream header | Voice line icon button | Browser build, non-macOS build, or preload missing `speechStart` | Click button | Help note opens; copy states macOS desktop requirement or speech service unavailable | No call ownership or audio session starts | Source: `CallTargetButton`; manual browser shell check | P1 |
| VM-VOICE-003 | Bot workstream header | Voice line icon button | TTS not configured | Click button | Help note explains voice setup need; button stays discoverable | No hidden control; no crash; no ghost active state | `CallView.tsx`, `SpeakButton.tsx` | P1 |
| VM-VOICE-004 | Bot workstream header | `Open operator settings` in help note | `setupBotId` is defined and voice setup is required | Click CTA | Settings open; correct operator selected first when setup target differs from current target | Focus should not be lost into background content | Manual desktop settings check | P1 |
| VM-VOICE-005 | Crew workstream header | Crew voice line icon | One or more members have no voice | Click button | Help note states every crew operator needs a voice | Crew line does not start with partial voice coverage | `GroupCallView.tsx` | P1 |
| VM-VOICE-006 | Voice line overlay | Opening a call | Supported macOS desktop, voice configured | Click voice line button | Overlay mounts, focus moves into overlay, previous focus is remembered, phase starts in `working` or `listening` | No backlog is spoken on open; old messages are marked as already spoken | `CallView.tsx`; `call.test.ts` | P0 |
| VM-VOICE-007 | Voice line overlay | `Escape` | Active call | Press `Escape` | Call ends, TTS stops, cleanup is deferred safely, focus returns to opener | Stale cleanup from an older overlay must not hang up the new call | `call.test.ts` | P0 |
| VM-VOICE-008 | Voice line overlay | `Space` during operator speech | Active call in `speaking` | Press `Space` | TTS interrupts immediately without closing the call | Space must not send transcript text or reopen mic early | `CallView.tsx`, manual audio check | P1 |
| VM-VOICE-009 | Voice line overlay | Push-to-talk chord | Active call in `listening` | Hold `Control` + `Option`, speak, release | Mic starts, transcript appears live, release finalizes capture after endpoint timeout | Microphone denial shows clear note; no hard crash | `CallView.tsx`; manual permission denial | P0 |
| VM-VOICE-010 | Voice line overlay | Spoken approval answer | Pending approval card is active | Say exact allow or deny phrase | Renderer dispatches allow/deny only for full unqualified phrases; microphone stays closed until server patch resolves | Ambiguous phrases are rejected and approval is re-asked | `CallView.test.ts`, `voice-gate.ts` | P0 |
| VM-VOICE-011 | Voice line overlay | Spoken freeform question answer | Pending question card is active | Speak one complete answer | Answer is submitted as `behavior: answer` and call returns to working/listening after response lifecycle | Duplicate submits must not happen on slow response | `CallView.tsx` logic; manual intercept | P1 |
| VM-VOICE-012 | Voice line overlay | Narration of live work | Operator starts tool work after call begins | Observe a long run | New `tool.spoken` activity is narrated aloud; silence does not make the line feel dropped | Existing transcript history is not re-narrated | `CallView.tsx`, `docs/voice-mode.md` | P1 |
| VM-VOICE-013 | Crew voice line overlay | Spoken addressing | Crew line active with multiple members | Say member name or `everyone` prefix | Message is normalized to `@Member` or `@everyone` exactly once | Ordinary speech must remain plain text; explicit tags preserved | `group-call.test.ts` | P1 |
| VM-VOICE-014 | Crew voice line overlay | Queued multi-speaker narration | Two members answer quickly | Observe queue ordering | Replies play sequentially; later member must not cut off earlier narration | Stop voice clears queue, prevents stuck speaking member id, and resumes listen/working correctly | `GroupCallView.tsx` | P1 |
| VM-VOICE-015 | Transcript message action | `SpeakButton` | Voice absent or bot voice missing | Hover/focus/click | Button stays visible with explanatory `aria-label`; click is inert | Hidden or silently dead button is a fail | `SpeakButton.tsx` | P2 |
| VM-VOICE-016 | Transcript message action | `SpeakButton` while speaking | Message already speaking | Click same button | Same control becomes stop action and halts TTS | Another message should not remain marked as speaking | `SpeakButton.tsx`; manual TTS state check | P2 |

### Desktop mobile setup and recovery surfaces

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-MOB-001 | Sidebar | Phone status button | Companion bridge unavailable | Open sidebar | Tooltip and status label say Helmryth Mobile is unavailable; click still routes user to desktop settings owner | Connection details are never leaked in the tooltip | `SidebarPhoneButton.test.ts` | P1 |
| VM-MOB-002 | Sidebar | Phone status button | No paired devices, mobile enabled | Hover/focus/click | Label reads `Connect Helmryth Mobile`; plus badge shown only in unpaired state; click dispatches settings section `companion` | Connected styling must not appear for stale `lastSeenAt` fallback | `SidebarPhoneButton.test.ts` | P1 |
| VM-MOB-003 | Sidebar | Phone status button | Paired devices with `connectedDeviceIds` | Open sidebar | Green status only when authenticated live streams exist; partial live count is phrased accurately | Old unpackaged fallback status must stay neutral | `SidebarPhoneButton.test.ts` | P1 |
| VM-MOB-004 | Mobile setup intro | Primary CTA | Companion state loaded | Click `Pair Helmryth Mobile` or `Pair another Mobile device` | Flow starts, heading receives focus, errors clear, generation increments | Button disabled while controller is busy or account busy | `PhoneSetupFlow.tsx` | P1 |
| VM-MOB-005 | Mobile setup intro | `Not now` in onboarding variant | Onboarding variant | Click `Not now` | Flow state resets with `skip`; owner callback runs | No open pairing window remains on sidecar | `PhoneSetupFlow.tsx` | P2 |
| VM-MOB-006 | Mobile sign-in phase | Email field + `Email me a code` | Account bridge available, signed out | Submit valid email | Code request begins, busy state renders, code field appears on success | Invalid or empty email must not submit | `PhoneSetupFlow.tsx` | P1 |
| VM-MOB-007 | Mobile sign-in phase | 8-digit code field + verify | Code sent | Enter 8 digits and submit | Account verify succeeds, code clears, automatic pairing preparation begins | Wrong code shows human-readable error and keeps user on sign-in | `PhoneSetupFlow.tsx` | P1 |
| VM-MOB-008 | Mobile sign-in phase | `Use this Wi-Fi instead` | Hosted route unavailable, slow, or user prefers local | Click fallback | Flow moves to local pairing mode without widening protected route policy | Hosted timeout must not silently downgrade to LAN without explicit user action | `PhoneSetupFlow.tsx`, `companion-pairing.test.ts` | P0 |
| VM-MOB-009 | Mobile sign-in phase | `Pair over Tailscale` | Tailnet route available | Click button | Tailscale-specific pairing attempt starts and copy reflects private tailnet use | If MagicDNS unavailable, clear error is shown and no dead QR remains | `PhoneSetupFlow.tsx` | P1 |
| VM-MOB-010 | Mobile provisioning phase | Automatic preparation | Hosted relay ready or signing in | Wait | Heading and body match route mode; QR or manual code appears only when route pin and token still match | If protected route is withdrawn or token changes, flow resets fail-closed with explicit error | `PhoneSetupFlow.tsx`, `companion-pairing.test.ts` | P0 |
| VM-MOB-011 | Mobile QR phase | QR render | Pairing open and `pairingLink` valid | Inspect QR area | QR image renders with accessible label; correct manual code placement depends on QR availability | If no link can be built, direct manual code is shown instead of blank QR | `CompanionSection.test.ts`, `PhoneSetupFlow.tsx` | P1 |
| VM-MOB-012 | Mobile QR phase | `Create a new code` | Current pairing code present or expired | Click button | New pairing token/code replaces old one and old token is closed when still owned | Previous token must not remain accepted | `devices.test.ts`, `PhoneSetupFlow.tsx` | P0 |
| VM-MOB-013 | Mobile QR/provisioning phase | `Cancel` or `Back` | Pairing in progress | Cancel | Pairing UI owner and generation are invalidated; sidecar pairing closes only if still owned; local state resets | A later flow must not be closed by a stale cancel | `PhoneSetupFlow.tsx` | P0 |
| VM-MOB-014 | Mobile success phase | Completion CTA | New device detected over baseline | Click `Start using Helmryth` or `Return to Mobile settings` | Flow ends cleanly and paired device is preserved | Success must not reopen QR flow on next poll | `PhoneSetupFlow.tsx` | P2 |
| VM-MOB-015 | Pairing trace & recovery | `Helmryth Mobile access` switch | Companion state loaded | Toggle off and on | Sidecar starts or stops through bridge; errors surface in visible alert region | Turning off must not falsely show healthy paired status | `CompanionSection.tsx`, `CompanionSection.test.ts` | P1 |
| VM-MOB-016 | Pairing trace & recovery | `Keep the host workbench awake` switch | Mobile access enabled | Toggle switch | Keep-awake mutation persists and reflects latest bridge state | Control disabled while mobile access is off | `CompanionSection.tsx` | P2 |
| VM-MOB-017 | Pairing trace & recovery | Relay `Sign out` / `Retry secure access` | Account ready, connecting, or error | Click control | Signs out or retries without exposing tokens; account error region updates | Retry failure must not drop existing recoverable state | `CompanionSection.tsx`, `electron/companion-account-service.test.mjs` | P0 |
| VM-MOB-018 | Pairing trace & recovery | `Reveal` / `Copy` route detail | Routes present | Reveal/copy each route | Redacted preview expands only on explicit reveal; copy success announces politely | Clipboard failure reveals value and shows manual-copy alert | `ConnectionDetail.tsx`, `ConnectionDetail.test.ts` | P2 |
| VM-MOB-019 | Paired devices list | Workbench access switch | Device exists | Toggle `Allow Workbench control` | Bridge mutates per-device cloud desktop access only for selected device | Save failure rolls back and surfaces error | `CompanionSection.tsx`, `devices.test.ts` | P0 |
| VM-MOB-020 | Paired devices list | Remove device trash button + gate | Device exists | Open gate, tab-cycle, confirm or cancel | Alertdialog traps focus, `Escape` cancels when idle, confirm revokes device and closes live streams | Busy confirm must not allow dismiss that hides in-flight state | `CompanionSection.tsx`, manual keyboard check | P0 |

### Companion control plane and device-facing route boundary

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-CTRL-001 | Control plane `GET /` | Loopback browser open | Control server bound locally | Open page on `127.0.0.1` or `localhost` | Page renders state and actions with no build dependency | Non-loopback `Host` must be refused | `control.ts`, `proxy.test.ts` | P0 |
| VM-CTRL-002 | Control plane `GET /state` | API poll | Loopback request | Request state | Returns current pairing, devices, endpoints, discovery, and live connected device ids | Stale cache is unacceptable; data is recomputed per request | `control.ts` | P1 |
| VM-CTRL-003 | Control plane `POST /pairing` | Start pairing | Loopback request with same-origin browser or non-browser client | Start pairing | Returns `201` plus fresh `code`, `token`, and state snapshot | Cross-origin browser post must be refused before mutation | `control.ts`, `proxy.test.ts` | P0 |
| VM-CTRL-004 | Control plane `DELETE /pairing` | Cancel pairing | Pairing window active | Cancel with optional `expectedToken` | Only the named pairing window closes; returns refreshed state | Wrong or stale token must not close newer window | `control.ts`, `devices.test.ts` | P0 |
| VM-CTRL-005 | Control plane `PUT /hosted-endpoint` | Hosted route publish/withdraw | Electron owner present | Send valid JSON `{ "url": "https://..." }` or `null` | Hosted URL normalizes to HTTPS origin or clears; returned state updates endpoints | Invalid JSON, large body, path/query/credential URL return `400` | `control.ts`, `endpoints.test.ts` | P0 |
| VM-CTRL-006 | Control plane `POST/DELETE /devices/:id/cloud-desktop` | Device capability change | Device exists | Enable then disable | Per-device cloud desktop access persists exactly for that device | Unknown device returns `404`; failed save returns `500` | `control.ts`, `devices.test.ts` | P0 |
| VM-CTRL-007 | Control plane `DELETE /devices/:id` | Device revoke | Device exists | Revoke | Device disappears from registry and all live streams for it terminate | Unknown device returns `404` without side effects | `control.ts`, `connected-devices.test.ts` | P0 |
| VM-CTRL-008 | Device API `POST /api/pair` | Pairing redemption | Unpaired device with open pairing window | Redeem QR token or 6-digit code | Returns device token once; pairing window is burned; device is stored without plaintext token | Wrong-code retry budget burns window after limit | `proxy.test.ts`, `devices.test.ts` | P0 |
| VM-CTRL-009 | Device API `GET /api/health` | Liveness check | Any client | Call health | Minimal non-cacheable liveness response works without token | Should not leak more than basic identity/liveness | `proxy.test.ts` | P1 |
| VM-CTRL-010 | Device API route allowlist | Authenticated app request | Paired bearer token | Exercise all allowed methods from route matrix | Allowed routes proxy successfully and preserve intended method exactness | Prefix tricks, wrong methods, unknown routes, and internal routes are denied | `routes.test.ts` | P0 |
| VM-CTRL-011 | Device API auth | Missing or malformed bearer | Any request except pair/health | Request allowed path | Response is `401` with pairing guidance | Device token near-miss must not authenticate | `devices.test.ts`, `proxy.test.ts` | P0 |
| VM-CTRL-012 | Device API origin hardening | Browser `Origin` header present | Any token state | Send request with `Origin` | Request is refused before token check | Stops CSRF-like browser submissions from arbitrary pages | `proxy.test.ts` | P0 |
| VM-CTRL-013 | Device API event stream | `GET /api/events` | Paired token and healthy harness | Open SSE | Resume cursor preserved, scrubbed frames stream through, revocation closes stream | Unterminated upstream events or quiet upstream must end cleanly with failure | `proxy.test.ts`, `upstream-failure.test.ts` | P0 |
| VM-CTRL-014 | Device API endpoint refresh | `GET /api/companion/endpoints` | Paired token | Fetch endpoints | Authenticated endpoint snapshot returns hosted and direct candidates only | Wrong method or unauthenticated request denied | `routes.test.ts`, `proxy.test.ts` | P1 |
| VM-CTRL-015 | Device API response scrubbing | Cloud desktop join | Device has or lacks workbench access | Request join | Sidecar forwards only for enabled device and returns only fresh viewer URL | If access is off, request is denied; provider/session cursors never leak | `proxy-response.test.ts` | P0 |
| VM-CTRL-016 | Device registry persistence | Sidecar restart | Paired devices exist | Restart sidecar and reload | Device registry survives restart; missing labels heal forward | Corrupt `devices.json` yields safe empty registry instead of crash | `devices.test.ts` | P1 |

### Android USB workbench

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-AND-001 | Android workbench panel | Device status poll | ADB bridge available, page visible | Open panel | Devices poll every 2s; selected device defaults to first authorized or first listed | Hidden page stops polling and clears frame state | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-002 | Android workbench panel | Unauthorized device warning | USB device in `unauthorized` state | View panel | Warning explains unlock + `Allow USB debugging` requirement | No interactive mirror or controls shown | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-003 | Android workbench panel | Interactive mirror focus | Authorized device selected | Focus frame area and press `Enter` or click | Input capture starts; help text flips to captured instructions | Blur or `Escape` releases capture | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-004 | Android workbench panel | Pointer tap | Authorized device with live frame | Click/tap within rendered phone bounds | Sends normalized `tap` with width and height from real image | Click outside fitted phone bounds does nothing | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-005 | Android workbench panel | Pointer swipe | Authorized device with live frame | Drag across frame | Sends `swipe` with start/end unit points and duration | Pointer cancel leaves no stuck gesture | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-006 | Android workbench panel | Wheel gesture | Captured focus | Scroll wheel horizontally or vertically | Aggregates deltas and sends one swipe from center after debounce | Tiny jitter below threshold sends nothing | `AndroidDevicePanel.tsx` | P2 |
| VM-AND-007 | Android workbench panel | Keyboard navigation | Captured focus | Use arrows, `Enter`, delete, or plain printable key | Named keys map to Android commands; printable chars send `text` | `Tab` leaves browser focus chain; modifier chords are ignored | `AndroidDevicePanel.tsx` | P1 |
| VM-AND-008 | Android workbench panel | Bottom nav buttons | Authorized device selected | Click `Back`, `Home`, `Recents` | Sends matching named key event | Buttons remain reachable with 44px-equivalent target sizing | `AndroidDevicePanel.tsx` | P2 |
| VM-AND-009 | Android workbench panel | Frame polling and errors | Authorized device selected | Force frame/input failure | Alert region appears with technical details in disclosure | Error must not freeze status selection or trap focus | `AndroidDevicePanel.tsx` | P1 |

### iOS companion and widgets

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-IOS-001 | Welcome / unpaired home | `Connect my workbench` or `Connect workbench` | Fresh install or skipped first launch | Tap CTA | Router opens pairing flow instead of dropping user into empty chats | Settings remain reachable from unpaired home | `OnboardingTests.swift`, `OnboardingViews.swift` | P1 |
| VM-IOS-002 | Notification onboarding | `Enable notifications` | Just paired, pending notification education marker | Tap CTA | App requests permission or opens iPhone Settings when denied; pending marker clears appropriately | Choosing `Not now` advances without re-showing on every launch | `OnboardingTests.swift`, `SettingsView.swift` | P1 |
| VM-IOS-003 | Pairing scanner | QR scan | Camera permission not resolved or denied | Open scanner | Shows progress then permission UI or scanner unavailable fallback; settings shortcut works | Re-entering foreground after permission change refreshes immediately | `PairingScanner.swift` | P1 |
| VM-IOS-004 | Pairing flow | QR invite acceptance | Valid Helmryth pairing QR | Scan QR | App shows explicit consent screen with workbench name and normalized origin before connect | Invalid QR says it is not a Helmryth pairing code | `PairingView.swift`, `ConnectionTests.swift` | P0 |
| VM-IOS-005 | Pairing flow | Manual address entry | User opens `Other ways to connect` | Enter address and continue | Address parsing accepts safe host/port forms, including IPv6 rules owned by `CompanionCore` | Invalid text shows actionable error and does not widen route policy | `PairingView.swift`, `ConnectionTests.swift` | P0 |
| VM-IOS-006 | Pairing flow | 6-digit code entry | Nearby/manual connection selected | Enter six digits and connect | Numeric-only clamp enforced; connect button enables only at 6 digits | Failed non-route error clears code and request id for fresh retry | `PairingView.swift` | P1 |
| VM-IOS-007 | Pairing session logic | Protected route failover | Hosted or tailnet invite | Pair against transient network failures | Retry uses same logical request id, protects credentials, and never falls back to disallowed LAN | All failed probes must leave credential unspent | `PairingTests.swift`, `FailoverTests.swift` | P0 |
| VM-IOS-008 | Session lifecycle | Foreground connect / background linger | Paired app | Background then foreground app | Stream lingers for roughly 25s, then disconnects cleanly; foreground reconnect resumes from cursor | Cancellation due to background is not treated as failure banner | `Session.swift` | P1 |
| VM-IOS-009 | Session restore | Locked keychain after reboot | Saved connection exists, token protected | Launch before first unlock | Status is offline with unlock guidance, not unpaired; pairing screen does not reappear | After unlock and foreground connect, restore retries automatically | `Session.swift` | P0 |
| VM-IOS-010 | Workstream view | Open chat | Live paired client | Open bot or room | Chat opens at newest message, unread is cleared, earlier messages load on demand, streaming text follows bottom | Live transcript and reasoning do not duplicate settled reply | `ChatView.swift`, `StoreTests.swift` | P1 |
| VM-IOS-011 | Workstream view | Composer send and dictation | Live paired client | Type/send or use dictation | Message send goes through server; dictation appends/merges text as designed | Empty search/query style actions should remain inert | `Session.swift`, `DictationTests.swift` | P1 |
| VM-IOS-012 | Workstream view | Interrupt button | Busy bot chat | Tap interrupt | Server receives interrupt; stream reflects change | Unauthorized interrupt should set status to unauthorized | `ChatView.swift`, `Session.swift` | P1 |
| VM-IOS-013 | Updates sheet | Needs-you pills | Updates present | Open sheet, answer from pill | Exact server card options render as pills; answer goes through session and state updates through stream | Answer buttons disable while submitting | `UpdatesSheet.swift` | P1 |
| VM-IOS-014 | Notification handling | Tapped alert or replayed notification | Notification payload references bot or room | Tap notification | App hydrates if needed, opens correct room or bot, and degrades to current task if stale | If unpaired but restore pending, target is retained until unlock; otherwise actionable pairing error is shown | `Notifications.swift`, `Session.swift` | P0 |
| VM-IOS-015 | Computer preview | Screen watch | Open cloud operator computer view | Enter/leave view | `watchScreen` is enabled only while visible; still frame and idle state copy are honest | No background frame streaming after leaving view | `ComputerView.swift`, `StoreTests.swift` | P1 |
| VM-IOS-016 | Cloud workbench control | `Open live cloud workbench` | Operator supports cloud desktop and this device is allowed | Confirm prompt and open | Fresh HTTPS viewer URL opens in sheet; URL is not persisted in state | Unsupported VPS backend hides button entirely; unauthorized request flips status | `ComputerView.swift`, `ConnectionTests.swift`, `proxy-response.test.ts` | P0 |
| VM-IOS-017 | Settings | Notifications row | Any paired state | Open Settings and interact | Status text matches authorization state; denied state opens system settings instead of prompting again | Footer truthfully states no terminated-app delivery yet | `SettingsView.swift`, `Session.swift` | P2 |
| VM-IOS-018 | Settings | Connection details reveal/copy/edit | Paired state | Show, copy, edit address, reconnect | Full address reveal is explicit, copy works, edit resets route policy to selected endpoint and reconnects now | Bad edit is rejected and pairing trust is preserved | `SettingsView.swift`, `Session.swift` | P1 |
| VM-IOS-019 | Widgets and Live Activities | Live operator update | Activities enabled, foreground stream live | Observe operator move between working and needs-you | Activity starts/updates/ends per operator, alerting only on new needs-you requests, options match card exactly | No push path means terminated app cannot keep updates current; stale activity ends on next launch if operator moved on | `LiveActivities.swift`, `HelmrythWidgets.swift` | P1 |
| VM-IOS-020 | Widget approval buttons | Answer from lock screen / Dynamic Island | Live Activity has pending request with options | Tap answer | Intent routes to `Session.answer(threadId:requestId:choice:isPermission:)` with exact option text | No invented option labels; denial tint is visually distinct but still labeled | `HelmrythWidgets.swift`, `LiveActivities.swift` | P1 |

### iOS source-ledger cases

These rows extend the higher-level iOS coverage above. They bind every control-bearing Swift file currently found under `ios/App` and `ios/Widgets` to explicit checks.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority |
|---|---|---|---|---|---|---|---|---|
| VM-IOS-021 | `ios/App/CompanionApp.swift` root routing | App launch, `onOpenURL`, global error alert `OK` | Any onboarding/pairing state | Launch app, open pairing URL, trigger `session.actionError`, dismiss alert | Route resolves to welcome, pairing, unpaired home, notification prompt, chats, or revoked screen exactly from current state; tapping `OK` clears `session.actionError` | Background -> active transition must reconnect and refresh notification status; stale pairing request must not reopen after a voluntary unpair | Source: `CompanionApp.swift`, `OnboardingTests.swift` | P0 |
| VM-IOS-022 | `ios/App/CompanionApp.swift` revoked surface | `Pair again` | `session.status == .unauthorized` | Open revoked route and tap CTA | Phone signs out local pairing state and starts a fresh pairing flow | Revoked state must not leave stale chats accessible or silently retry with dead token | `CompanionApp.swift` | P0 |
| VM-IOS-023 | `ios/App/OnboardingViews.swift` welcome screen | `Connect my workbench`, `Not now` | First-launch welcome route | Tap each CTA | `Connect my workbench` moves into pairing; `Not now` marks welcome as seen and lands on useful unpaired home | Skip must not auto-open pairing on later launch without user action or invite | `OnboardingViews.swift`, `OnboardingTests.swift` | P1 |
| VM-IOS-024 | `ios/App/OnboardingViews.swift` unpaired home | Bottom `Connect workbench`, toolbar `Settings` | Unpaired home route | Tap both controls | Connect opens pairing; Settings opens unpaired-safe settings surface | Navigation must stay available on compact phones and not hide the bottom CTA behind safe areas | `OnboardingViews.swift` | P1 |
| VM-IOS-025 | `ios/App/OnboardingViews.swift` notification education | `Enable notifications`, `Not now` | Notification onboarding route after first pair | Tap both controls | Enable requests permission or opens iPhone Settings when denied, then advances; `Not now` advances without claiming alerts are always-on | Copy must stay truthful that closed-app delivery is not available yet | `OnboardingViews.swift`, `Session.swift`, `OnboardingTests.swift` | P1 |
| VM-IOS-026 | `ios/App/PairingView.swift` navigation gate | Toolbar `Not now`, interactive dismiss | Pairing screen open | Attempt to dismiss before and during submission | Normal dismissal works only while `submission.allowsNavigation`; in-flight submission disables navigation and keeps consent stable | Deep links arriving during commit must queue until the in-flight request settles | `PairingView.swift` | P1 |
| VM-IOS-027 | `ios/App/PairingView.swift` QR path | `Scan QR code`, scanner full-screen cover | Unpaired route with camera-capable device | Tap scan, scan valid and invalid QR | Valid Helmryth QR fills consent screen with workbench name and normalized origin; invalid QR shows explicit validation error | QR path must never pair silently without the consent card and `Connect` tap | `PairingView.swift`, `PairingScanner.swift`, `ConnectionTests.swift` | P0 |
| VM-IOS-028 | `ios/App/PairingView.swift` alternate routes | `Other ways to connect`, nearby discovery list, `Enter address and code` disclosure | Pairing view open | Expand disclosures, wait for discovery, collapse/reopen | Discovery only runs while disclosure is open; empty, loading, and failure states are distinct; manual entry remains available | Discovery stop on disappear must prevent stale results from reopening a dismissed sheet | `PairingView.swift`, `Discovery.swift` | P1 |
| VM-IOS-029 | `ios/App/PairingView.swift` manual address entry | `Workbench address` field, `Continue` | Manual disclosure open | Enter valid and invalid addresses | Valid parse moves to confirmation; invalid input shows actionable error copied from the phone-safe parser contract | Ambiguous, unsafe, or downgraded addresses must be refused before any redemption attempt | `PairingView.swift`, `ConnectionTests.swift` | P0 |
| VM-IOS-030 | `ios/App/PairingView.swift` nearby/manual confirmation | `Connect` with scanned credential or 6-digit code, `Choose a different workbench` | Confirmation card visible | Connect with QR token, then with manual code, then reset | QR path uses credential directly; manual path enforces 6-digit numeric code; reset clears code, QR credential, and request id | On non-route failures the QR path must require a fresh rescan; manual path clears only when appropriate | `PairingView.swift`, `PairingTests.swift` | P0 |
| VM-IOS-031 | `ios/App/PairingScanner.swift` camera permission and fallback | `Open Settings`, `Cancel`, live scanner payload validation | Scanner sheet presented | Deny camera, grant later, present unsupported device, cancel | Permission states render correctly; returning from Settings refreshes access; unsupported scanner tells user to use Camera app or manual entry | Repeated invalid QR frames must be throttled so one bad code does not spam failures | `PairingScanner.swift` | P1 |
| VM-IOS-032 | `ios/App/ChatListView.swift` header and root navigation | Header `Settings`, bottom `Updates`, `Search`, `New operator` | Paired chat list | Tap each control from live, connecting, and offline states | Header subtitle reflects pairing state; Settings opens settings; Updates opens sheet; Search opens field; New operator creates and navigates to the new chat | New operator failure must surface via root alert, not a silent no-op | `ChatListView.swift`, `Session.swift` | P1 |
| VM-IOS-033 | `ios/App/ChatListView.swift` crews strip | Crew `NavigationLink`, `New crew` tile | One or more rooms or operators exist | Open an existing crew and create a new one | Existing crew tiles navigate to the room; New crew opens `NewGroupSheet` | Unread badge and avatar stacking must stay visible on compact widths and VoiceOver should not lose the tile label | `ChatListView.swift`, `NewGroupSheet.swift` | P1 |
| VM-IOS-034 | `ios/App/ChatListView.swift` search mode | Search field, clear `x`, `Cancel`, search-hit button, pull-to-refresh | Search bar open | Search with <2 chars, >=2 chars, clear, cancel, open hit, refresh | `<2` chars clear message hits; debounced search returns hits; clear and cancel reset focus and query; opening a hit pushes the correct chat | Search results must not linger after query clears or after a newer query finishes later | `ChatListView.swift`, `Session.open(_:)`, `StoreTests.swift` | P1 |
| VM-IOS-035 | `ios/App/NewGroupSheet.swift` crew creation | `Crew name` field, member toggles, `Create`, `Cancel` | Paired chat list with visible operators | Select/deselect members, leave name blank, create, cancel | Selection state is explicit; create stays disabled until one member is selected; blank name defers to server naming rule; cancel dismisses cleanly | Multiple taps on Create must not double-submit; hidden operators must not appear as choices | `NewGroupSheet.swift`, `Session.createRoom` | P1 |
| VM-IOS-036 | `ios/App/ChatView.swift` header chrome | `Back`, header face/profile button, header name pill, `Watch workbench` | Open bot or room chat | Tap each header control with unread count present/absent | Back dismisses to roster; bot profile opens profile sheet; room pill opens plus-sheet; workbench button appears only for bot chats | Header face seat must be inaccessible while opening island animation owns the tap target | `ChatView.swift` | P1 |
| VM-IOS-037 | `ios/App/ChatView.swift` transcript pagination | `Load earlier messages` | Thread has `hasMore == true` | Tap button repeatedly | Older messages prepend and scroll anchor stays on the previously top visible message | A failed older-page fetch must surface a user-visible error and leave current transcript intact | `ChatView.swift`, `StoreTests.swift` | P1 |
| VM-IOS-038 | `ios/App/ChatView.swift` plus-sheet actions | `New run`, `Runs`, `Watch workbench`, `Share transcript`, `Share as JSON`, `Interrupt`, tap-away dismiss | Chat plus-sheet open | Exercise each visible action for bot, room, busy, and pending-approval contexts | Visible actions match chat type and busy state; share opens system share sheet with exported file; interrupt only appears for busy bots | Disabled actions must stay visible enough to explain why they are unavailable; tap-away must close without triggering an action | `ChatView.swift`, `TaskManagerView.swift`, `ComputerView.swift` | P1 |
| VM-IOS-039 | `ios/App/ChatView.swift` composer chrome | `More`, `Methods`, text field, `mic`, send arrow | Chat open | Toggle plus-sheet, show/hide methods HUD, type, dictation, send | Plus button rotates and re-labels close/open state; methods HUD follows `/`; dictation blocks direct editing while listening; send clears draft and submits once | Empty send must stay disabled; starting dictation must stop any pending permission prompt reopen behavior | `ChatView.swift`, `DictationTests.swift` | P0 |
| VM-IOS-040 | `ios/App/Composer/CommandSkillHUDView.swift` methods HUD | Command cards, close button, slash filtering | HUD visible from composer | Type `/`, filter commands, select command, close HUD | Cards filter on title/description; selecting a command closes HUD and dispatches the right action or prompt; close clears lone slash draft | Room chats must hide methods that do not apply, especially `/computer` and task-only variants | `CommandSkillHUDView.swift`, `ChatView.swift` | P1 |
| VM-IOS-041 | `ios/App/Composer/PredictiveActionChipsView.swift` prompt chips | Default chip taps | Composer empty, chat idle, no pending approval | Tap each chip | Each chip submits its exact prompt through the normal send path | Chips must disappear when typing starts, while busy, or while a pending approval is active | `PredictiveActionChipsView.swift`, `ChatView.swift` | P2 |
| VM-IOS-042 | `ios/App/ChatView.swift` reactions and versioning | Reaction pill buttons, emoji context-menu buttons, version chevrons | Message with reactions or versions | Toggle a reaction, add via context menu, move between versions | Reaction counts and tint update through patch events; version chevrons move among versions and disable at bounds | Editing/retry remains unavailable while a bot is busy and version controls must not appear for room chats | `ChatView.swift`, `Session.react`, `Session.switchVersion` | P1 |
| VM-IOS-043 | `ios/App/ChatView.swift` edit-and-retry | Context menu `Edit and retry`, alert text field, `Send`, `Cancel` | User text message in bot chat | Open menu, edit text, send, cancel | New version is created through `session.edit`; cancel leaves transcript unchanged | Empty trimmed edit must not submit; room chats must not expose edit-and-retry | `ChatView.swift` | P1 |
| VM-IOS-044 | `ios/App/ChatView.swift` option cards | Pending option buttons, `Always allow this tool`, answered label | Pending approval or question card visible | Answer allow/deny/question, then use always-allow path | Only server-offered options are shown and sent; always-allow uses the server-issued key and then answers with the selected allow option | Refusal styling must not be the only cue; double taps while `answering` must not send duplicates | `ChatView.swift`, `Session.answer`, `Session.alwaysAllow` | P0 |
| VM-IOS-045 | `ios/App/AgentProfileView.swift` avatar section | Shape picker, `Upload image`, `Use operator mark` | Bot profile open | Change crop, upload valid/invalid/oversize image, clear image | Crop persists through a successful save/upload; invalid type or >10 MB image raises phone-safe error; clearing returns to operator mark | Upload should convert `operatorMark` crop intent to a real image crop instead of leaving invalid mixed state | `AgentProfileView.swift`, `ProfileClientTests.swift` | P1 |
| VM-IOS-046 | `ios/App/AgentProfileView.swift` generation and identity | Art-direction field, `Generate on workbench`, name/title/description fields, notification toggle | Profile open with config loaded | Generate with and without provider config, edit identity, toggle notifications | Generate button only enables with non-empty prompt and configured provider; profile patch sends only changed phone-owned fields | iOS must not invent narrower server limits or silently trim beyond the documented server contract | `AgentProfileView.swift`, `ProfileClientTests.swift` | P1 |
| VM-IOS-047 | `ios/App/AgentProfileView.swift` voice controls | Voice picker, `Speak replies`, `Preview voice`, `Save profile`, `Done` | Profile open with config and voices loaded | Test workspace default, operator-specific voice, preview, save, dismiss | Voice choices follow provider state; `Speak replies` disables if chosen voice cannot speak; preview plays a sample; save requires non-empty name | Built-in Mac voices unavailable and ElevenLabs-unconfigured states must render different remediation text | `AgentProfileView.swift`, `ProfileRoutinePolicyTests.swift` | P1 |
| VM-IOS-048 | `ios/App/TaskManagerView.swift` run switching and editing | Run row button, context-menu `Rename`, swipe `Delete`, toolbar `Done`, `New run` | Task manager open for bot or room | Switch runs, rename, delete, create, dismiss | Tapping a run switches context and dismisses; rename and create alerts submit through the matching bot/room route; delete respects single-run and busy guards | The destructive swipe must stay disabled when only one run remains or the current chat is busy | `TaskManagerView.swift`, `Session` task methods | P1 |
| VM-IOS-049 | `ios/App/TasksRoutinesView.swift` cadence list | Row tap edit, swipe `Pause/Resume`, swipe `Delete`, swipe/context `Run now`, context `Edit` | Runs & Cadences open with routines loaded | Exercise every row action on toggleable and non-toggleable routines | Swipe and context menu parity holds; completed or unsupported routines do not expose invalid toggles; reload reflects latest server state | Full-swipe leading action must not unexpectedly delete; disabled toggles need clear non-action behavior | `TasksRoutinesView.swift`, `ProfileRoutinePolicyTests.swift` | P1 |
| VM-IOS-050 | `ios/App/TasksRoutinesView.swift` cadence receipts | DisclosureGroup, `Open run` | Receipt exists with output, error, waiting state, or thread id | Expand receipts and open a run | Output and errors remain text-selectable; waiting state is explicit; `Open run` routes through notification-target logic | Missing bot/thread data must not crash the disclosure or open the wrong conversation | `TasksRoutinesView.swift`, `Session.openNotification` | P1 |
| VM-IOS-051 | `ios/App/TasksRoutinesView.swift` cadence editor work section | `Cadence name`, operator picker, prompt field, duration stepper | New or edit cadence sheet open | Populate fields and vary empty/filled states | Save stays disabled until required fields are valid; operator defaults to first visible bot on appear | iOS-side truncation must follow current code only where intended: name 80 chars, prompt 20,000 chars, duration 15-240 step 15 | `TasksRoutinesView.swift` | P1 |
| VM-IOS-052 | `ios/App/TasksRoutinesView.swift` cadence editor scheduling | Run-location picker, repeat picker, date pickers, weekday buttons, `Save`, `Cancel` | Editor open with cloud availability loaded or unavailable | Switch local/cloud, once/daily/unknown schedules, toggle weekdays, save, cancel | Cloud choice follows availability policy; once requires future date; daily requires at least one weekday; unsupported newer schedules must be converted before save | Existing cloud selections must remain preserved but unsaveable until prerequisites exist, not silently rewritten | `TasksRoutinesView.swift`, `ProfileRoutinePolicyTests.swift` | P0 |
| VM-IOS-053 | `ios/App/ConnectedAppsView.swift` inventory states | Pull-to-refresh, toolbar `Refresh`, search field | Connected-apps screen open | Load with authoritative, stale, empty, and unreadable-credential-store responses; refresh and search | View distinguishes unknown, stale, empty, configured, and needs-setup states; query filters by label or slug | A non-authoritative empty response must not wipe the last known connected inventory | `ConnectedAppsView.swift` | P0 |
| VM-IOS-054 | `ios/App/ConnectedAppsView.swift` connect and alias flows | `Connect <app>`, `Add another account`, alias alert `Continue`/`Cancel` | Catalog configured and connector cards loaded | Start first connect, add alias, continue, cancel, exceed account cap | First connect opens authorization URL; alias trims whitespace and caps length at 64; add-another disables at 5 accounts | Browser-open failure must raise a visible action error instead of silently swallowing the authorization URL | `ConnectedAppsView.swift`, `Session.authorizeConnector` | P1 |
| VM-IOS-055 | `ios/App/ComputerView.swift` preview lifecycle | Screen preview appear/disappear, `Open live cloud workbench`, confirm `Cancel/Open workbench`, viewer sheet | Bot chat supports workbench preview | Enter view, wait for frames, open/close interactive viewer | `watchScreen` only lives while view is visible; preview labels idle vs preview honestly; interactive viewer opens from a fresh URL | Busy/idle still-frame ambiguity must be resolved by the status text, and unsupported VPS bots must not show the control at all | `ComputerView.swift`, `Session.watchScreen`, `Session.cloudDesktop` | P1 |
| VM-IOS-056 | `ios/App/SettingsView.swift` top-level settings | Workbench NavigationLink or connect button, Notifications row, `Runs & Cadences`, `Capabilities` | Paired and unpaired states | Exercise every top-level row in paired/unpaired/denied-notification states | Workbench row shows status-first summary; notifications row either requests permission or opens iPhone Settings; workspace links appear only when paired | Footer must remain consistent with actual foreground-only delivery behavior | `SettingsView.swift`, `Session.notificationStatusText` | P1 |
| VM-IOS-057 | `ios/App/SettingsView.swift` connection security details | `Connection details` disclosure, `Show/Hide full address`, `Copy`, `Edit address`, `Try reconnecting`, `Remove connection from this iPhone` | Paired workbench row opened | Reveal/hide/copy address, edit valid and invalid address, retry, remove | Address reveal is explicit; copy gives temporary copied state; valid edits reset route policy and reconnect; remove signs out via confirmation dialog | Invalid address must not destroy pairing trust; remove must clear pending onboarding markers and badge count | `SettingsView.swift`, `Session.updateAddress`, `Session.signOut` | P0 |
| VM-IOS-058 | `ios/App/UpdatesSheet.swift` active-updates sheet | Row open button, answer pills | Updates sheet presented | Open working/review rows and answer needs-you rows | Needs-you, Working, and To review grouping stays correct; answer pills are exact server options and disable while submitting | Empty state must render `Nothing needs you` instead of a blank sheet | `UpdatesSheet.swift`, `Session.answer` | P1 |
| VM-IOS-059 | `ios/App/Island.swift` needs-you island | Tap-away dismiss, avatar open, answer buttons | At least one `needsYou` update exists | Let island appear, dismiss by background tap, reopen with new card, open chat, answer options | Island expands only for current non-dismissed request id; avatar opens the chat; answer submits once and dismisses island | A dismissed card id must not re-show until a different request arrives; animation should quiesce after 30s | `Island.swift`, `ChatListView.swift` | P1 |
| VM-IOS-060 | `ios/App/Glass.swift` shared chrome button contract | `GlassButton` and capsule/sheet surfaces | Any iPhone size class | Exercise standard 44pt round controls built from glass primitives | Buttons remain hittable at `44x44`, preserve circular content shape, and degrade from iOS 26 Liquid Glass to pre-iOS-26 material without losing hit testing | Visual fallback must not shrink targets or hide focus/pressed affordances on older runtimes | `Glass.swift` | P2 |
| VM-IOS-061 | `ios/App/Cards/AgentThoughtChamberView.swift` reasoning card | Header expand/collapse button | A streaming or settled reasoning card is visible | Toggle open and closed | `Trace Ledger` expands to numbered steps; streaming indicator pulses only while streaming | Empty or whitespace-only reasoning should not create meaningless rows or broken counts | `AgentThoughtChamberView.swift` | P2 |
| VM-IOS-062 | `ios/App/Cards/GitPRDiffCardView.swift` diff card | `View Diff/Hide Diff`, `Show all lines`, `Copy Diff` | Bot message parses as diff | Toggle visibility, expand large diff, copy | Diff header shows derived add/delete counts; 80-line clamp expands on request; copy always includes full diff | Large diffs must not truncate copied output, and horizontal scroll must preserve line coloring/readability | `GitPRDiffCardView.swift` | P2 |
| VM-IOS-063 | `ios/App/Cards/SQLResultTableView.swift` table card | `Copy CSV` | Bot message parses as markdown table | Copy CSV from narrow and wide tables | CSV output includes headers and properly quotes commas, quotes, and newlines | Ragged rows must not parse as a table and should fall back to ordinary markdown/text rendering | `SQLResultTableView.swift`, `TextBubble` parsing logic | P2 |
| VM-IOS-064 | `ios/App/Cards/SkillExecutionReceiptView.swift` tool-receipt card | Header expand/collapse button | Activity chip visible with and without details | Toggle details on receipts with input/output and on receipts without them | Detail toggle works only when there are parameters or output; status badge reflects running/success/error | No-details receipts must not pretend to expand or trap taps in dead affordances | `SkillExecutionReceiptView.swift` | P2 |
| VM-IOS-065 | `ios/Widgets/HelmrythWidgets.swift` widget and Dynamic Island controls | Lock-screen and island answer buttons | Live Activity has pending request options | Tap each option from compact/expanded states where supported | Buttons render exactly the server-provided options, preserve refusal tint distinction, and dispatch the matching intent payload | Long option lists must remain readable and tappable; unsupported activity state should degrade without empty controls | `HelmrythWidgets.swift`, `LiveActivities.swift` | P1 |

## Route and capability matrix

### Device-facing allowed routes

These routes are intended to be exercised from the iOS app and must keep method-exact behavior:

- `GET /api/config`
- `GET /api/events`
- `GET /api/instances`
- `GET /api/companion/endpoints`
- `GET /api/bots`
- `POST /api/bots`
- `POST /api/bots/:botId/messages`
- `POST /api/bots/:botId/interrupt`
- `POST /api/bots/:botId/read`
- `POST /api/bots/:botId/always-allow`
- `POST /api/bots/:botId/messages/:messageId/edit`
- `POST /api/bots/:botId/active-branch`
- `POST`, `PATCH`, `DELETE` task routes for bots and groups
- `PATCH /api/bots/:botId/profile`
- `POST /api/bots/:botId/avatar/generate`
- `POST /api/bots/:botId/computer/join`
- `POST /api/groups`
- `POST /api/groups/:groupId/messages`
- `POST /api/groups/:groupId/read`
- `GET /api/threads/:threadId/messages`
- `GET /api/threads/:threadId/messages/:messageId/image`
- `POST /api/threads/:threadId/messages/:messageId/reactions`
- `GET /api/threads/:threadId/export`
- `POST /api/threads/:threadId/respond`
- `GET /api/search`
- `POST /api/attachments`
- `GET /api/attachments/:filename`
- `GET /api/tts/voices`
- `POST /api/tts/speak`
- `GET`, `POST`, `PATCH`, `DELETE`, `POST run` routine routes
- `GET /api/connectors/catalog`
- `GET /api/connectors/connected`
- `GET /api/connectors`
- `POST /api/connectors/:slug/authorize`

### Explicit denials

These are intentional fail-closed checks and must be regression-tested whenever the harness adds new host capabilities:

- Device requests with any browser `Origin` header are rejected.
- Pairing administration and revocation are not exposed on the device API.
- API keys and host configuration remain workbench-only.
- Local VM setup and lifecycle remain workbench-only.
- Webhook creation and secret rotation remain workbench-only.
- Connector removal and broad connected-app administration remain workbench-only.
- Team import/export remains workbench-only.
- Internal peer-agent routes must 404 rather than advertise themselves.
- Cloud computer provisioning and shell/screenshot APIs are not exposed; the phone receives only a fresh join URL.

## Expanded end-to-end scenarios

### VM-E2E-001 - Desktop operator voice line remains half-duplex and safe

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** macOS desktop
- **Surface / route:** Bot workstream header to active voice overlay
- **Controls / triggers:** Voice line button, push-to-talk chord, `Space`, `Escape`
- **Preconditions and fixtures:** macOS desktop build, microphone and Speech Recognition allowed, TTS configured for the operator, test operator able to emit long-running tool narration and a gate
- **Steps:**
  1. Start a voice line from an idle operator.
  2. Hold `Control + Option`, speak a prompt, release.
  3. While the operator is speaking, press `Space`.
  4. Trigger a pending approval and answer once with `yes`, once with an ambiguous phrase such as `yeah no`, and once with `no`.
  5. End the line with `Escape`.
- **Expected visible output:** Overlay focus trap holds; transcript area shows live heard text; note copy appears on permission problems; active call button switches to hang-up state.
- **Expected persisted / network output:** Only one message send per spoken prompt; allow/deny dispatch occurs only on exact full-decision phrases; ambiguous phrase sends nothing.
- **Failure and recovery assertions:** Intentional speech stop must not emit natural completion that reopens the mic mid-TTS; stale cleanup from a previous overlay must not close the current call.
- **Accessibility assertions:** Focus enters overlay, cycles with `Tab`, `Escape` exits, controls have spoken labels, and instructions remain visible.
- **Security and privacy assertions:** No gate is granted from qualified or mixed language.
- **Cleanup / reset:** End call and clear pending approvals.
- **Automation mapping:** `src/lib/call.test.ts`, `src/components/CallView.test.ts`
- **Evidence to retain:** Screen recording with audio, analytics event for call start, transcript/network log proving one approval decision per spoken phrase.

### VM-E2E-002 - Crew voice line queues multiple members without double-speaking

- **Priority:** P1
- **Execution:** Manual - executable
- **Platforms:** macOS desktop
- **Surface / route:** Crew workstream voice line
- **Controls / triggers:** Voice line button, spoken `@member` routing, stop voice button
- **Preconditions and fixtures:** Every crew member has a configured voice; one scenario where two members answer quickly
- **Steps:**
  1. Start a crew line.
  2. Speak to one named operator, then to everyone.
  3. Force two sequential spoken responses from different members.
  4. Use `Stop voice` while the second response is queued.
- **Expected visible output:** Speaking member identity tracks the current speaker; button copy shows crew-specific instructions.
- **Expected persisted / network output:** Named speech is normalized to `@Member`; room-wide speech can normalize to `@everyone`.
- **Failure and recovery assertions:** Later queued replies must not clip earlier ones; after stop, queue drains and listening resumes safely.
- **Accessibility assertions:** Overlay instructions and active member indicators are readable and keyboard-accessible.
- **Security and privacy assertions:** Spoken gate decisions remain narrow and explicit even in crew context.
- **Cleanup / reset:** End the crew line.
- **Automation mapping:** `src/lib/group-call.test.ts`
- **Evidence to retain:** Audio/video capture and network traces of normalized outgoing room messages.

### VM-E2E-003 - Hosted pairing never silently downgrades to local HTTP

- **Priority:** P0
- **Execution:** Automated - passing when suite is green
- **Platforms:** Desktop renderer, sidecar, iOS core package
- **Surface / route:** Desktop setup flow, pairing link generation, iOS pairing failover
- **Controls / triggers:** Automatic QR creation, hosted withdrawal, retry
- **Preconditions and fixtures:** Hosted route initially available, local LAN route also available
- **Steps:**
  1. Open automatic pairing.
  2. Withdraw the hosted route before the phone redeems the credential.
  3. Attempt to continue pairing without explicit fallback action.
- **Expected visible output:** Desktop resets the flow with secure-route failure copy; iOS never receives a downgraded consent target.
- **Expected persisted / network output:** Protected route pin becomes invalid; old token is closed if still owned.
- **Failure and recovery assertions:** Retry succeeds only after a fresh code or explicit fallback path.
- **Accessibility assertions:** Error is announced in alertable text.
- **Security and privacy assertions:** Protected invite never probes or redeems on LAN/Bonjour when policy forbids it.
- **Cleanup / reset:** Reopen pairing as local or hosted intentionally.
- **Automation mapping:** `src/lib/companion-pairing.test.ts`, `ios/Tests/CompanionCoreTests/PairingTests.swift`, `EndpointRefreshTests.swift`
- **Evidence to retain:** Test logs showing protected route pin invalidation and no LAN fallback.

### VM-E2E-004 - Desktop pairing cancellation cannot close a newer pairing window

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** Desktop renderer plus sidecar
- **Surface / route:** Desktop mobile setup flow
- **Controls / triggers:** Start pairing, refresh or start a second attempt, cancel the older UI
- **Preconditions and fixtures:** Sidecar running; ability to trigger multiple pairing generations quickly
- **Steps:**
  1. Start a pairing attempt.
  2. Generate a fresh code before redeeming the first.
  3. Cancel the older UI state or invoke cleanup from the earlier generation.
- **Expected visible output:** Only the active flow remains; old QR/code disappears.
- **Expected persisted / network output:** `expectedToken` semantics close only the owned pairing window.
- **Failure and recovery assertions:** New token remains usable; old cancel path cannot burn it.
- **Accessibility assertions:** Focus follows the active phase heading after each transition.
- **Security and privacy assertions:** Token ownership gates every destructive close.
- **Cleanup / reset:** Leave one active pairing or cancel latest.
- **Automation mapping:** `devices.test.ts`, `PhoneSetupFlow.tsx`
- **Evidence to retain:** Sidecar logs or network trace showing token-specific close.

### VM-E2E-005 - Revoking a phone immediately kills its live relay access

- **Priority:** P0
- **Execution:** Automated - passing when suite is green; manual spot-check recommended
- **Platforms:** Desktop sidecar, iOS or API client
- **Surface / route:** Desktop paired-device revoke gate
- **Controls / triggers:** Remove device dialog and confirm
- **Preconditions and fixtures:** Paired device with an open authenticated event stream
- **Steps:**
  1. Open revoke gate for the active device.
  2. Confirm revocation.
  3. Observe the open device stream and follow-up requests.
- **Expected visible output:** Device disappears from paired list; stream-backed status drops from connected to unavailable/offline.
- **Expected persisted / network output:** Registry removes device; connected stream cleanup fires idempotently; follow-up API calls fail auth.
- **Failure and recovery assertions:** Revoking one device must not touch others.
- **Accessibility assertions:** Alertdialog traps focus and returns it to the opener after close.
- **Security and privacy assertions:** Revoked bearer cannot keep reading the API.
- **Cleanup / reset:** Re-pair device if continuing tests.
- **Automation mapping:** `companion/test/devices.test.ts`, `connected-devices.test.ts`, `proxy.test.ts`
- **Evidence to retain:** Event-stream disconnect log and failed post-revoke authenticated request.

### VM-E2E-006 - Cross-origin browser page cannot drive the loopback control plane

- **Priority:** P0
- **Execution:** Automated - passing when suite is green
- **Platforms:** Sidecar control plane
- **Surface / route:** `POST /pairing`, `DELETE /devices/:id`, all control methods
- **Controls / triggers:** Browser request with foreign `Origin`
- **Preconditions and fixtures:** Control server running on loopback
- **Steps:**
  1. Send a browser-like request with a non-matching loopback or remote origin.
  2. Repeat with opaque `null` origin and malformed authority cases.
- **Expected visible output:** Not applicable.
- **Expected persisted / network output:** All requests fail `403` before mutation.
- **Failure and recovery assertions:** Control state remains unchanged.
- **Accessibility assertions:** Not applicable.
- **Security and privacy assertions:** Prevents CSRF-style local control attacks.
- **Cleanup / reset:** None.
- **Automation mapping:** `companion/test/proxy.test.ts`, `control.ts`
- **Evidence to retain:** Response codes and unchanged control state snapshot.

### VM-E2E-007 - Android USB workbench input capture is explicit and reversible

- **Priority:** P1
- **Execution:** Manual - executable
- **Platforms:** macOS/Windows/Linux desktop with supported Android tooling and real device
- **Surface / route:** Desktop Computer panel -> Android workbench
- **Controls / triggers:** Focus, `Enter`, pointer tap/drag, wheel, `Escape`, nav buttons
- **Preconditions and fixtures:** Real Android phone over data-capable USB, Developer Options and USB debugging enabled, device authorized for host
- **Steps:**
  1. Connect device and open panel.
  2. Capture input by focusing panel and pressing `Enter`.
  3. Tap, swipe, wheel-scroll, type text, and use Back/Home/Recents.
  4. Press `Escape`, then `Tab`.
- **Expected visible output:** Help text changes when captured; mirror updates on 850 ms cadence; nav buttons remain visible.
- **Expected persisted / network output:** Input commands target only the selected serial and carry image width/height.
- **Failure and recovery assertions:** Loss of authorization or frame failure surfaces an error without breaking device selection.
- **Accessibility assertions:** Workbench group is keyboard-focusable and instructions are spoken.
- **Security and privacy assertions:** Session stays local to authorized USB connection; no mobile pairing or relay requirement is introduced.
- **Cleanup / reset:** Release input and disconnect device.
- **Automation mapping:** Source-only; no dedicated automated panel tests found
- **Evidence to retain:** Real-device screen recording and ADB command logs.

### VM-E2E-008 - iPhone QR pairing requires visible user consent

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** Real iPhone on iOS 17+
- **Surface / route:** iOS PairingView and PairingScannerSheet
- **Controls / triggers:** Scan QR, consent screen, connect
- **Preconditions and fixtures:** Fresh open pairing QR from workbench; camera permission granted
- **Steps:**
  1. Launch the iOS app from unpaired state.
  2. Scan a valid Helmryth pairing QR.
  3. Verify workbench name, connection badge, and normalized origin.
  4. Complete connect.
- **Expected visible output:** Consent screen appears before redemption, with `HTTPS connection`, `Tailscale connection`, or `Trusted local connection` badge as appropriate.
- **Expected persisted / network output:** Device token is stored in Keychain only; UserDefaults stores connection metadata separately; welcome/onboarding route advances appropriately.
- **Failure and recovery assertions:** Deep link or second invite received during in-flight pairing cannot silently replace the current consent screen.
- **Accessibility assertions:** Buttons are full-width, scanner fallback copy is readable, number entry is large and centered.
- **Security and privacy assertions:** QR cannot silently pair; target address is shown for inspection.
- **Cleanup / reset:** Sign out or revoke device if repeating.
- **Automation mapping:** `ConnectionTests.swift`, `PairingTests.swift`, `OnboardingTests.swift`
- **Evidence to retain:** Real-device video and Keychain/UserDefaults inspection if available through debug tools.

### VM-E2E-009 - iOS restore after reboot does not misclassify locked Keychain as unpaired

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** Real iPhone
- **Surface / route:** App launch and `Session.restore()`
- **Controls / triggers:** Launch before first unlock after reboot, then unlock and foreground app
- **Preconditions and fixtures:** Existing paired connection; rebooted iPhone not yet unlocked
- **Steps:**
  1. Reboot device and launch app before first unlock if possible via notification or manual launch path.
  2. Observe status.
  3. Unlock phone and foreground app again.
- **Expected visible output:** App shows offline guidance to unlock, not pairing UI; after unlock it reconnects.
- **Expected persisted / network output:** Saved connection stays intact; no token deletion; pending notification can be replayed after restore.
- **Failure and recovery assertions:** User is not forced to re-pair for a locked-keychain transient.
- **Accessibility assertions:** Offline error copy is actionable and readable.
- **Security and privacy assertions:** Keychain-protected token is not copied elsewhere to bypass lock.
- **Cleanup / reset:** None.
- **Automation mapping:** `Session.swift` source-backed only
- **Evidence to retain:** Real-device launch logs and screenshots pre/post unlock.

### VM-E2E-010 - Notifications and Live Activity route into the correct conversation

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** Real iPhone with notifications and Dynamic Island or lock screen support as available
- **Surface / route:** Notification banner, Updates sheet, Live Activity answer buttons
- **Controls / triggers:** Tapped notification, lock-screen answer, Updates sheet answer
- **Preconditions and fixtures:** Paired device, live stream, operator gate or room question event
- **Steps:**
  1. Trigger a bot approval and a room approval on the workbench.
  2. Tap the banner for each.
  3. Answer once from Updates sheet and once from Live Activity.
- **Expected visible output:** Bot notification opens bot chat; room notification opens room chat or current task if stale; answer pills match card options exactly.
- **Expected persisted / network output:** Notification payload carries threadId/botId/kind only; answer uses exact threadId/requestId/choice.
- **Failure and recovery assertions:** Replay after short disconnect must not duplicate banner delivery.
- **Accessibility assertions:** Buttons remain large enough on lock screen and sheet; labels are not icon-only.
- **Security and privacy assertions:** No hidden or invented action labels; permission answers map to allow/deny only.
- **Cleanup / reset:** Clear outstanding approvals.
- **Automation mapping:** `StoreTests.swift`, `LiveActivities.swift`, `Notifications.swift`
- **Evidence to retain:** Notification center screenshots, Xcode console, server request logs.

### VM-E2E-011 - iOS cloud workbench access stays per-device and explicit

- **Priority:** P0
- **Execution:** Manual - executable
- **Platforms:** Real iPhone plus desktop host with cloud operator
- **Surface / route:** Desktop per-device workbench-access toggle and iOS `ComputerView`
- **Controls / triggers:** Desktop switch, iOS `Open live cloud workbench`
- **Preconditions and fixtures:** Cloud-capable operator, one paired iPhone denied and then allowed, second device optionally left denied
- **Steps:**
  1. Keep workbench access disabled and attempt to open from iPhone.
  2. Enable access on desktop for that device only.
  3. Re-open iPhone view and confirm prompt.
- **Expected visible output:** Button appears only for supported cloud operators; access prompt warns about full control implications.
- **Expected persisted / network output:** Sidecar forwards join only for allowed device and returns a fresh HTTPS URL not stored in state.
- **Failure and recovery assertions:** Unauthorized call should not fall back to stale URL or partial control.
- **Accessibility assertions:** Confirm dialog has explicit cancel/open affordances and readable warning text.
- **Security and privacy assertions:** Access is per-device, not global to all phones.
- **Cleanup / reset:** Disable access again if not desired.
- **Automation mapping:** `proxy-response.test.ts`, `devices.test.ts`
- **Evidence to retain:** Desktop setting snapshot, successful/failed join responses, iOS screen recording.

### VM-E2E-012 - Foreground-only iOS delivery limit is honest in product behavior

- **Priority:** P1
- **Execution:** Manual - executable
- **Platforms:** Real iPhone
- **Surface / route:** Notification onboarding, Settings footer, Live Activity lifecycle
- **Controls / triggers:** Background app beyond linger window, terminate app, trigger workbench event
- **Preconditions and fixtures:** Paired device, notifications allowed
- **Steps:**
  1. Background the app briefly and trigger an event.
  2. Background past the linger window and trigger another event.
  3. Force-quit the app and trigger a final event.
- **Expected visible output:** First event may arrive while lingering; later/terminated events do not falsely appear as supported closed-app delivery.
- **Expected persisted / network output:** Stream disconnects cleanly after linger; next foreground reconnect hydrates missed state.
- **Failure and recovery assertions:** Product copy and actual behavior stay aligned; no stale claim of always-on push exists.
- **Accessibility assertions:** Settings footer and onboarding copy remain readable.
- **Security and privacy assertions:** No hidden background wake path or polling loophole claims are made.
- **Cleanup / reset:** Reopen app to hydrate latest state.
- **Automation mapping:** Source-backed only
- **Evidence to retain:** Timestamped notification screenshots and app lifecycle logs.

## Automation map

- Desktop voice logic and mobile setup helpers:
  - `src/lib/call.test.ts`
  - `src/lib/group-call.test.ts`
  - `src/lib/companion-pairing.test.ts`
  - `src/components/CallView.test.ts`
  - `src/components/CompanionSection.test.ts`
  - `src/components/ConnectionDetail.test.ts`
  - `src/components/SidebarPhoneButton.test.ts`
- Sidecar and control/security boundary:
  - `companion/test/routes.test.ts`
  - `companion/test/proxy.test.ts`
  - `companion/test/proxy-response.test.ts`
  - `companion/test/devices.test.ts`
  - `companion/test/endpoints.test.ts`
  - `companion/test/connected-devices.test.ts`
  - `companion/test/control.test.ts`
  - `companion/test/upstream-failure.test.ts`
  - `companion/test/mdns.test.ts`
  - `companion/test/origin.test.ts`
  - `companion/test/ports.test.ts`
  - `companion/test/wire.test.ts`
  - `companion/test/advertise-watch.test.ts`
- Electron bridges:
  - `electron/companion-entry.test.mjs`
  - `electron/companion-origin-gateway.test.mjs`
  - `electron/companion-account-service.test.mjs`
  - `electron/skill-recorder.test.mjs`
- iOS `CompanionCore` package:
  - `ios/Tests/CompanionCoreTests/ConnectionTests.swift`
  - `PairingTests.swift`
  - `FailoverTests.swift`
  - `EndpointRefreshTests.swift`
  - `EventStreamTests.swift`
  - `SSETests.swift`
  - `StoreTests.swift`
  - `OnboardingTests.swift`
  - `DictationTests.swift`
  - `ProfileClientTests.swift`
  - `ProfileRoutinePolicyTests.swift`

## Manual-only and partially verified gaps

These remain outside code-level execution on this machine and require explicit device or packaging passes before release sign-off:

- Real macOS microphone, Speech Recognition, and TTS audio-device behavior for one-to-one and crew voice lines
- Real iPhone camera permission flow, QR scanning latency, nearby Bonjour discovery, and Keychain-after-reboot restore behavior
- Real iPhone notification banners, lock-screen actions, Dynamic Island rendering, and Live Activity update timing
- Real cloud workbench control from iPhone against a live enabled device
- Real Android USB device mirroring, focus capture, wheel-to-swipe ergonomics, and manufacturer-specific debug-authorize prompts
- Packaged Electron behavior for speech helper bundle identity, recorder helper identity, and companion sidecar launch selection
- Cross-platform desktop checks on Windows and Linux for non-voice surfaces in this file; desktop voice itself is intentionally macOS-only

## Release gate for this domain

This domain is release-ready only when all of the following are true:

- Targeted desktop, sidecar, Electron, and `swift test` suites are green on fresh execution.
- A real macOS manual pass confirms operator and crew voice flows, including permissions and gate speech.
- A real iPhone manual pass confirms pairing, reconnect, notifications, Updates sheet answering, and cloud desktop prompt behavior.
- A real Android manual pass confirms at least one authorized USB device across mirror, tap, swipe, nav keys, and error recovery.
- No new harness route intended for mobile access is merged without a corresponding `companion/src/routes.ts` update and test coverage.
