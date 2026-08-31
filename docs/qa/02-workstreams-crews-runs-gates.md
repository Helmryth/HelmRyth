# Workstreams, crews, runs, gates, and record interaction QA

This document is the executable QA contract for Helmryth’s core work surface. It covers direct operator workstreams, crew workstreams, run boundaries, message rendering and actions, the composer and artifact intake, replies, record marks, search, revisions and alternate paths, queued and steered directions, gates, opening briefs, credential requests, interruption, REST persistence, and live-event recovery.

The vocabulary in this document is user-facing Helmryth vocabulary. Existing compatibility-only source and transport names such as `Bot`, `Group`, `Task`, `/api/bots`, and `/api/groups` are quoted only when identifying an exact implementation contract.

## Source inventory and test boundary

Primary rendered surfaces:

- `src/components/ChatView.tsx`, `GroupView.tsx`, `Composer.tsx`, `TaskPicker.tsx`
- `ChatMarkdown.tsx`, `ComposerAttachments.tsx`, `AttachmentPreview.tsx`
- `ReplyQuote.tsx`, `Reactions.tsx`, `ChatFindBar.tsx`, `SearchResults.tsx`, `TurnPresence.tsx`
- `ApprovalCard.tsx`, `PendingApproval.tsx`, `SecretRequestCard.tsx`, `OptionCard.tsx`
- `BotPickerList.tsx`, `ManageMembersPanel.tsx`

State and service boundaries:

- `src/state/store.tsx` and `src/lib/{drafts,composer-attachments,replies,focus-message,live-events,transcript-window,bottom-follow}.ts`
- `server/index.ts`, `server/store.ts`, `server/message-db.ts`, `server/thread-events.ts`
- `server/send-idempotency.ts`, `server/steer-queue.ts`, `server/replies.ts`

This is not a shallow click list. A case passes only when its visible result, HTTP result, persisted record, live event, focus result, and non-effects all match. Provider-dependent cases use the deterministic fake ACP/Claude adapters from the server test harness; no test may spend external credits or contact a real account.

## Canonical fixtures

| Fixture | Exact state |
|---|---|
| `OP-RIVET` | Operator “Rivet”; available fake provider; queueing and steering enabled; image input enabled; `autoApprove=false`; one default run. |
| `OP-CAIRN` | Operator “Cairn”; available fake provider; queueing disabled; image input disabled; two runs. |
| `OP-VESPER` | Operator “Vesper”; archived only in negative roster cases; unavailable provider instance. |
| `CREW-FORGE` | Crew “Forge Line”; members Rivet and Cairn; routing `mentions`; setup complete; no active turn. |
| `CREW-NEW` | Crew “Field Draft”; Rivet and Cairn; setup neither completed nor skipped; empty transcript. |
| `RUN-A` | Active run titled “Release audit”; 140 records; one user revision fork; one pinned record; one reply; reactions by user and Rivet. |
| `RUN-B` | Inactive run titled “Packaging evidence”; 8 records; no pin and no pending gate. |
| `RUN-GATE` | Active run with two unresolved gates, oldest first. |
| `MSG-USER` | Plain user text record with a reply target and one alternate revision. |
| `MSG-OP` | Settled operator Markdown containing headings, GFM table, task list, fenced source, spoiler, web link, safe local-file link, and image. |
| `MSG-ACTIVE` | In-flight capability record followed by buffered assistant text. |
| `GATE-SHELL` | Pending `Bash` gate with exact command resource, consequence, requester, `allowKey=shell:project`, and held reason. |
| `GATE-CADENCE` | Pending cadence-create gate with schedule and instructions. |
| `CRED-KEY` | Pending credential gate targeting a test key in a disposable credential store; help URL is HTTPS. |
| `ARTIFACTS` | 2 KB PNG, 2 KB JPEG, 20 KB UTF-8 text, local PDF path, unsupported executable, image at exact size limit, image one byte over limit, corrupt image bytes, long paste, and duplicate filenames. |

All IDs above are logical fixture names. The runner records the generated UUIDs in its evidence manifest. Every test gets an isolated data directory, attachment directory, credential store, SQLite database, and provider session registry.

## Execution matrix and evidence contract

Run the rendered cases at **390×844**, **768×1024**, and **1440×1000**. Run keyboard cases without a mouse. Repeat screen-reader assertions with VoiceOver on macOS and NVDA on Windows. Run service cases on macOS, Windows, and Ubuntu where filesystem syntax differs.

For every automated or manual run retain:

- test report and exact command;
- Playwright trace for a failure and screenshot for each width at the final assertion;
- request method, URL, status, sanitized request body, and response body;
- SQLite row IDs or JSON-store diff for persistence assertions;
- ordered SSE frame log including cursor and reconnect `hello` frame;
- accessibility snapshot for dialogs, gates, composer, run ledger, and record actions;
- confirmation that logs, transcript, SSE, clipboard, and screenshots contain no credential value.

`Automated — passing` means an existing repository test is named in Evidence. `Manual — executable` means the steps are complete but require the planned browser/device harness. A case is not “passing” merely because a nearby unit test exists.

## Workstream shell and record-window controls

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-SHL-001 | Direct workstream | Select Rivet in Roster | `RUN-A` exists | Activate Rivet | Header names Rivet and active run; `role=log` is named “Workstream record with Rivet”; active transcript and its draft load; unread clears | Selection must not merge records or draft from another run | `src/state/store.test.ts`; capture header, log and request | P0 | Manual — executable |
| WS-SHL-002 | Direct workstream | Operator sigil/profile button | Rivet selected | Click “Open Rivet's operator profile” | Operator settings opens for Rivet and focus enters the settings surface | No settings for previously selected operator; Escape follows modal contract | Component assertion + Playwright trace | P1 | Manual — executable |
| WS-SHL-003 | Direct workstream | Inline operator title rename | Idle operator | Activate rename, enter `Rivet Prime`, commit | Header and roster update; `PATCH /api/bots/:id`; persisted name survives restart; bot SSE refreshes peers | Empty, whitespace, over-limit, Escape, blur, duplicate rapid commit do not corrupt title | `src/components/RenameTitle.test.ts`; server profile tests | P1 | Manual — executable |
| WS-SHL-004 | Direct workstream | “Find in workstream” button / platform shortcut | Any populated run | Click button, then invoke Cmd/Ctrl+F while workstream focused | One find bar opens, button has `aria-pressed=true`, input is focused and selected | Repeating shortcut must not open browser find or duplicate the bar | `ChatFindBar.tsx`; browser trace | P1 | Manual — executable |
| WS-SHL-005 | Direct workstream | “Stop active run” header button | Rivet busy in active thread | Activate Stop | `POST /api/bots/:id/interrupt` targets active thread; open gates close; busy status and presence settle | Double activation is harmless; stale thread cannot interrupt newly selected run | `server/index.test.ts`, `server/tasks.test.ts` | P0 | Manual — executable |
| WS-SHL-006 | Direct workstream | Run picker trigger | At least two runs | Open ledger | Dialog named “Run ledger” opens; search autofocused; active run has `aria-current=page`; all runs are represented | Outside click and Escape close and return focus; no transcript mutation | `src/components/TaskPicker.test.ts` | P1 | Manual — executable |
| WS-SHL-007 | Direct workstream | Usage chip | Token usage exists | Activate chip | System/settings usage section opens; accessible name includes formatted total; exact input/output appears in title | Missing usage omits chip without blank focus stop | Manual accessibility snapshot | P2 | Manual — executable |
| WS-SHL-008 | Direct workstream | Workbench folder chip | Run has pinned folder | Activate chip | Operator settings opens to folder control; chip names folder and operator | Long Windows/Unix paths truncate visually but full accessible/title value remains | Manual at all widths | P1 | Manual — executable |
| WS-SHL-009 | Direct workstream | Model picker | Multiple available instances | Change model while idle | Selected model persists and header reflects it; no transcript loss | Active run forbids unsafe model switch; unavailable provider shows controlled error | Existing model/store tests; trace | P1 | Manual — executable |
| WS-SHL-010 | Direct workstream | “Open operator workbench” | Workbench closed | Activate | Workbench surface opens and button state is visible | Closing restores workstream width; at 390 it becomes a full-screen secondary surface | Workbench suite owns internals; screenshot here proves shell integration | P1 | Manual — executable |
| WS-SHL-011 | Direct workstream | “Open trace” | Trace closed | Activate twice | First opens Trace and sets `aria-pressed=true`; second closes and restores layout | No loss of scroll position or composer draft | Trace suite owns internals; shell Playwright trace | P1 | Manual — executable |
| WS-SHL-012 | Direct workstream | Pinned-entry banner “Jump” | Pin points to loaded record | Activate jump | Target run is active, window expands around target, record scrolls into view and receives temporary focus treatment | Missing/deleted/off-branch pin renders no stale banner and does not throw | `src/lib/focus-message.ts`, store tests | P1 | Manual — executable |
| WS-SHL-013 | Direct workstream | Pinned-entry banner “Unpin entry” | Valid pin | Activate | `PATCH /api/bots/:id {pinnedMessageId:""}`; banner disappears; persistence survives restart | Duplicate unpin remains successful; transcript unchanged | Server index pin tests + request capture | P1 | Manual — executable |
| WS-SHL-014 | Direct workstream | Run ledger disclosure | Tool timeline events exist | Expand then collapse | Up to eight recent steps show explicit running/complete/failed text and time; `aria-expanded` follows state | Zero events omits ledger; reduced motion removes decorative rotation/animation | `src/lib/activity-runs.test.ts`; snapshot | P2 | Manual — executable |
| WS-SHL-015 | Direct workstream | “Load earlier records” | 140-record run initially windowed | Activate repeatedly | Window start moves backward without duplication; count decreases; scroll anchor remains stable | Rapid clicks do not skip/reorder; earliest page removes control | `src/lib/transcript-window.test.ts` | P1 | Manual — executable |
| WS-SHL-016 | Direct workstream | “Load later records” | Landed around an older search hit | Activate | Later window expands toward current leaf; count decreases; target remains addressable | Switching branch/run cancels stale window result | `src/lib/transcript-window.test.ts`; search landing trace | P1 | Manual — executable |
| WS-SHL-017 | Direct workstream | Scroll upward / PageUp / Home | Bottom-follow active | Scroll upward or press PageUp | Automatic following disarms and “Latest entry” appears above composer | New streaming deltas must not pull reader away | `src/lib/bottom-follow.test.ts` | P1 | Manual — executable |
| WS-SHL-018 | Direct workstream | “Latest entry” | Reader away from tail | Activate | Full tail window restores, smooth scrolls to end, follow re-arms | Reduced motion uses non-disorienting movement; button never covers send control | `src/lib/bottom-follow.test.ts`; width screenshots | P1 | Manual — executable |
| WS-SHL-019 | Direct workstream | Empty state | Fresh run, no records | Open run | Concrete next action and operator context render; composer is available | No “Nothing here yet,” fake metric, stale record, or off-run gate | Visual snapshot | P1 | Manual — executable |
| WS-SHL-020 | Direct workstream | Provisioning state | Workbench provisioning frame | Observe | Polite status says “Preparing Rivet's workbench…” and disappears when settled | Reconnect must not leave spinner stranded after snapshot says idle | Store/SSE harness + screen recording | P1 | Manual — executable |
| WS-SHL-021 | Direct workstream | System notice | API action fails | Trigger controlled 409/500 | One `role=alert` shows sanitized Helmryth copy; draft and current records remain | Raw secret, host path, stack, provider token, old brand terms never appear | Error injection trace and redaction scan | P0 | Manual — executable |
| WS-SHL-022 | Direct workstream | Turn presence | Provider thinking, tool activity, streaming answer, completion | Observe phases | Named polite status shows concrete activity; streamed record hands off once to settled record; no duplicate content | Fast completion, reconnect and reduced motion do not leave stale presence | `src/lib/turn-tail.test.ts`; store runtime tests | P1 | Manual — executable |
| WS-SHL-023 | Crew workstream | Select Forge Line | Crew populated | Activate | Crew header, members, routing, active run, pin, and transcript hydrate atomically | Direct workstream state and draft do not leak | `src/state/store.test.ts`; group task tests | P0 | Manual — executable |
| WS-SHL-024 | Crew workstream | Crew find / Cmd/Ctrl+F | Crew populated | Open and close | Same find contract as direct workstream, scoped to crew thread | Search must not return other runs while scoped | `server/index.test.ts` search cases | P1 | Manual — executable |
| WS-SHL-025 | Crew workstream | Jump to latest | Reader above crew tail | Activate | Tail restores for crew active run; held composer remains visible | Does not dispatch held direction or alter routing | `bottom-follow.test.ts`; trace | P1 | Manual — executable |
| WS-SHL-026 | Any workstream | Day separators and timestamps | Records span two local dates | Inspect and change locale/time zone | Separators name dates in order; each record exposes ISO `dateTime` and full timestamp title | DST boundary does not reorder or duplicate | Manual clock-fixture test | P2 | Manual — executable |

## Message rendering and record actions

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-MSG-001 | Direct record | User text record | `MSG-USER` | Inspect | “Your direction” label, exact whitespace-preserved content, timestamp and action group render | Provider metadata and hidden attachment tags do not display as prose | Component snapshot | P1 | Manual — executable |
| WS-MSG-002 | Operator record | Settled Markdown | `MSG-OP` | Inspect | GFM headings, lists, task list, table, blockquote, inline/fenced code, link, image and rule render in light theme | Raw HTML/script is escaped; malformed Markdown falls back without white-screen | `ChatMarkdown.tsx`; security fixture | P0 | Manual — executable |
| WS-MSG-003 | Markdown source plate | “Copy source” | Clipboard granted | Activate | Exact fenced code copied; label/status becomes “Source copied,” then returns idle | Denied clipboard produces announced failure and no false success | Clipboard Playwright cases | P1 | Manual — executable |
| WS-MSG-004 | Markdown source plate | Streaming highlight | Code fence streams in chunks | Observe before/after 250 ms settle | Plain source stays current while streaming; highlighting occurs after stable content; settled cache reuses exact code | Unknown language leaves legible plain source; no stale shorter highlight | Component timer test to add; manual trace | P2 | Manual — executable |
| WS-MSG-005 | Markdown link | HTTPS link | Safe external URL | Activate normally and with keyboard | Shell external-link policy opens browser; new context is announced by platform; app route does not navigate | `javascript:`, `data:`, malformed and inherited-app deep links are blocked by shell policy | Electron URL-policy tests + manual | P0 | Manual — executable |
| WS-MSG-006 | Markdown local artifact | “Save local artifact: <path>” | Desktop bridge available; safe file | Activate; choose destination | Save dialog opens; success names destination; cancel is silent and non-error | Missing bridge, containment rejection, deleted source and write failure show explicit alert; modifier click cannot bypass bridge | Electron save-file tests; component trace | P0 | Manual — executable |
| WS-MSG-007 | Markdown spoiler | “Reveal hidden text” / “Hide revealed text” | `~~hidden~~` content | Reveal, read, hide | Text is excluded from accessible reading until reveal; controls have exact names; stored Markdown unchanged | Nested links/code do not leak before reveal | Accessibility snapshot | P1 | Manual — executable |
| WS-MSG-008 | Long user record | “Show full entry” / “Show less” | Over character/line threshold | Expand then collapse | Complete content becomes visible, then returns to bounded plate | Copy still copies full visible user content contract; focus remains on toggle | Component/manual | P2 | Manual — executable |
| WS-MSG-009 | Any text record | “Copy entry” | Clipboard available | Activate user and operator copy | User copy excludes hidden image tags/webhook wrapper; operator copy equals source text; success icon is non-color-only via label/title | Denied clipboard must not claim success; rapid clicks do not create timers after unmount | Browser clipboard trace | P1 | Manual — executable |
| WS-MSG-010 | User record | “Revise entry” | Idle, plain user message | Activate | Inline editor focuses at end; original text present; instructions exposed | Busy operator and inbound webhook omit revise control | `server/branching.test.ts`; component trace | P0 | Manual — executable |
| WS-MSG-011 | Revision editor | Enter / “Commit revision” | Edited non-empty text | Commit | `POST /api/bots/:id/messages/:messageId/edit`; new branch record is persisted; active leaf changes; provider reruns from new text | IME Enter does not submit; whitespace disables; two racing edits yield one accepted turn | `server/branching.test.ts` | P0 | Manual — executable |
| WS-MSG-012 | Revision editor | Shift+Enter | Editor open | Press Shift+Enter | Newline is inserted and editor remains open | No premature provider turn | Component keyboard trace | P1 | Manual — executable |
| WS-MSG-013 | Revision editor | Escape / “Keep original” | Editor changed | Cancel | Original branch and transcript remain; no HTTP request; focus returns to record action region | Blur caused by cancel must not submit | Component trace | P1 | Manual — executable |
| WS-MSG-014 | Operator record | “Run again from this point” | Last settled operator text; previous user line exists; idle | Activate | Composer/branch logic reruns from correct previous user message, creating accountable alternate outcome | Control absent while busy and on non-last operator record; duplicate click permits one turn | Branching integration test | P0 | Manual — executable |
| WS-MSG-015 | Revision navigation | “Previous revision” | Multiple versions | Activate | `POST /api/bots/:id/active-branch`; active path, messages, pin visibility and search state follow selected leaf | Busy disables; first version disables previous; request for unknown leaf is 404 with no mutation | `server/branching.test.ts` | P0 | Manual — executable |
| WS-MSG-016 | Revision navigation | “Next revision” | On earlier version | Activate | Next path becomes active and counter updates | Last version disables next; rapid alternating requests resolve to server-confirmed leaf | Branching tests + race trace | P0 | Manual — executable |
| WS-MSG-017 | Any text record | “Respond to entry” | No pending gate | Activate | Composer shows quoted author/snippet and focuses editor; eventual send carries `replyToId` | Switching run or clearing quote removes reply state; deleted target degrades to safe snippet behavior | `src/lib/replies.test.ts`, `server/replies.test.ts` | P1 | Manual — executable |
| WS-MSG-018 | Composer quote | “Clear quoted record” | Reply selected | Activate | Quote disappears; typed draft and artifacts remain; sent message has no `replyToId` | Clearing twice has no effect | `src/lib/replies.test.ts`; manual | P1 | Manual — executable |
| WS-MSG-019 | Settled reply quote | “Open quoted record from …” | Reply target on active path | Activate | Correct record is loaded/focused; run/branch ownership remains correct | Missing target gives controlled error, never jumps to same ID in another thread | `server/replies.test.ts`; focus trace | P1 | Manual — executable |
| WS-MSG-020 | Any record | “Pin entry” | No current pin | Activate | PATCH persists one pin; header banner appears with correct author/snippet | Invalid ID rejected by API; pinning second record replaces first only | Server pin route + restart test | P1 | Manual — executable |
| WS-MSG-021 | Any pinned record | “Unpin entry” | Record is current pin | Activate | Pin clears and banner disappears without record mutation | Off-branch/missing pin is non-fatal | Server index + trace | P1 | Manual — executable |
| WS-MSG-022 | Record marks | Five compact buttons | Desktop width ≥768 | Toggle each compact mark | POST reactions toggles user mark; `aria-pressed` and summary chip update | Rapid double toggle ends in parity-correct state; other users' marks remain | Store reducer + route test | P1 | Manual — executable |
| WS-MSG-023 | Record marks | “More record marks” | Any text record | Open picker | Group named “Record marks” opens; first choice gets focus; 22 named choices are operable | Escape/outside click/window blur closes and returns focus; only More control shows at 390 | Component accessibility trace | P1 | Manual — executable |
| WS-MSG-024 | Record mark choice | Any extended mark | Picker open | Activate | Mark toggles, picker closes, trigger regains focus; chip identifies mark and people | Unknown persisted emoji renders safe “Marked” label | Route + component trace | P1 | Manual — executable |
| WS-MSG-025 | Reaction chip | Aggregated mark | User and operators marked same record | Inspect and activate | Names resolve to “You” and current member names, count is accurate; activation toggles only current user's mark | Removed member displays “Operator”; duplicate server rows do not invent names | Component fixture | P1 | Manual — executable |
| WS-MSG-026 | Queued user record | “Remove queued direction” | Non-steering operator busy, queued message persisted | Activate | `DELETE /api/bots/:id/queue/:queueId`; only after 200 does optimistic queued item disappear | 404/network failure keeps item and announces error; later landed SSE consumes tombstone once | `server/steer-queue.test.ts`, `src/state/store.test.ts` | P0 | Manual — executable |
| WS-MSG-027 | Steered user record | “steered into active run” | Queue-capable provider accepted steer | Observe | User record carries `steered=true`, remains in same thread and provider context | Late steer acknowledgement after turn/run deletion must 409 and append nothing | `server/steer-e2e.test.ts` | P0 | Manual — executable |
| WS-MSG-028 | Capability record | running/complete/failed activity chip | Tool lifecycle messages | Observe | Accessible label says state and controlled method label; running has live status, complete/failed has explicit icon and text/color | Raw provider payload, secret or legacy vocabulary not rendered | Store runtime fixture + snapshot | P1 | Manual — executable |
| WS-MSG-029 | Operator handoff record | Handoff chip | Comms message includes crew ID | Activate | Selects exact crew; handoff context and named peer are visible | Deleted crew produces controlled unavailable result; no accidental creation | `server/comms.test.ts`; manual | P1 | Manual — executable |
| WS-MSG-030 | Inbound webhook record | “Inspect event record” disclosure | Sanitized webhook message | Expand | Task remains primary; payload appears in bounded scroll region | Credential fields stay redacted; raw HTML inert | `src/lib/webhook-message.test.ts`; webhook security cases | P0 | Manual — executable |
| WS-MSG-031 | Failed run block | “Try run again” | Retryable final error | Activate | Correct prior direction is resent once; failed state remains in history and new attempt is visible | Setup/auth errors show EngineSetup instead of futile retry | Driver retry tests; manual | P1 | Manual — executable |
| WS-MSG-032 | Failed Markdown subtree | Error boundary | Force renderer exception | Render | Plain-text recovery plate displays exact safe source; rest of workstream survives | No recursive failure or blank workstream | Component fault-injection test to add | P0 | Manual — executable |
| WS-MSG-033 | Attached image in record | Thumbnail | Valid same-origin saved path | Activate | Modal preview opens with correct image/name and focus trap | Foreign URL/path traversal never becomes same-origin attachment URL | `src/lib/composer-attachments.test.ts`; dialog trace | P0 | Manual — executable |
| WS-MSG-034 | Attachment preview | “Save a copy” | Preview open | Activate | Browser download/save occurs for exact generated attachment name | Corrupt/missing source shows unavailable state; no navigation | Browser download trace | P1 | Manual — executable |
| WS-MSG-035 | Attachment preview | Close, Escape, backdrop | Preview open | Exercise each close path | Dialog unmounts and prior trigger regains focus; Tab/Shift+Tab stay trapped while open | Click inside content does not close; repeated Escape harmless | `AttachmentPreview.tsx`; Playwright keyboard trace | P1 | Manual — executable |

## Composer, drafts, attachments, mentions, steering, and interruption

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-CMP-001 | Direct composer | Textarea “Direct Rivet” | Idle, no gate | Type ordinary text | Draft persists under operator+thread key; textarea grows to six lines; no request before send | Empty/whitespace has no send button; resize never covers controls | `server/drafts.test.ts`, `src/lib/composer-dock.test.ts` | P0 | Manual — executable |
| WS-CMP-002 | Composer | Enter | Non-empty draft, no IME composition | Press Enter | One `POST /api/bots/:id/messages` with trimmed composed text, stable `sendId`, active `threadId`, optional reply; 202 receipt; draft clears after snapshot is captured | Shift+Enter inserts newline; composing Enter does not send; key repeat creates one accepted message per unique send ID | `server/send-idempotency.test.ts`, `server/index.test.ts` | P0 | Manual — executable |
| WS-CMP-003 | Composer | Send-direction button | Non-empty text | Click | Same contract as Enter; accessible name is “Send direction” while idle | Double click/retry with same `sendId` returns canonical receipt and does not duplicate transcript/provider turn | `server/send-idempotency.test.ts` | P0 | Manual — executable |
| WS-CMP-004 | Composer | Empty artifact-only send | One valid attachment chip, no text | Activate send | Composed message contains exact attachment markup/path; receipt and rendered artifact are created once | Unsupported/removed artifact preserves draft and shows error rather than empty text send | `server/composer-attachments.test.ts` | P0 | Manual — executable |
| WS-CMP-005 | Composer | Shift+Enter | Non-empty text | Press Shift+Enter | Adds newline, draft revision advances, no request | At six visible lines editor scrolls internally and retains caret | Keyboard trace | P1 | Manual — executable |
| WS-CMP-006 | Composer | ArrowUp on empty editor | Prior user text exists, idle | Press ArrowUp | Latest editable user record opens revision editor | Busy, non-empty draft, webhook-only history or no user message leaves composer unchanged | Branching/manual trace | P1 | Manual — executable |
| WS-CMP-007 | Composer | Per-run draft isolation | Draft text/artifacts/reply in `RUN-A` | Switch to `RUN-B`, edit, switch back | Each run restores exact independent text, attachments, failed-send list and reply state | Failed old-run request cannot restore into newly active run | `server/drafts.test.ts`; state tests | P0 | Manual — executable |
| WS-CMP-008 | Composer | Failed-send recovery | Inject network failure after send snapshot | Observe | Alert names unsent direction; original draft is restored if unchanged; newer draft is retained and failure becomes separate retry item | Failure never loses text, artifacts, reply, run ID or stable send ID | `server/drafts.test.ts`; store error hook | P0 | Manual — executable |
| WS-CMP-009 | Failed-send alert | “Retry this direction” | Stored failure, target still owns thread | Activate | Same payload and `sendId` are retried; canonical receipt deduplicates; failure item clears only when retry starts | Wrong active run, deleted operator, missing image support or 409 restores failure without overwriting current draft | Idempotency + draft integration | P0 | Manual — executable |
| WS-CMP-010 | Failed-send alert | “Dismiss failed direction” | Stored failure | Activate | Only failed-send record is removed from local persistence; current draft unchanged | Reload confirms dismissal; no server transcript deletion | Draft unit test + browser reload | P1 | Manual — executable |
| WS-CMP-011 | Direct busy composer, steering provider | Enter / “Add direction to active step” | Rivet busy; queueing/steer enabled | Send | Adapter steer receives reply-aware prompt; if still busy, user message appends with `steered=true`; 202 includes message and `steered=true` | If turn settles, run switches, task deletes or operator deletes during await, server rechecks ownership and either starts normal turn or returns 409 without stray append | `server/steer-e2e.test.ts` | P0 | Manual — executable |
| WS-CMP-012 | Direct busy composer, non-steering provider | Enter / “Hold this direction next” | Cairn busy | Send | Server queue persists direction and returns `queued=true`, `queueId`; pending chip names held text | Stop clears queue; settled turn drains FIFO into same run; no concurrent provider turn | `server/steer-queue.test.ts` | P0 | Manual — executable |
| WS-CMP-013 | Held-direction chip | “Remove held direction” | One or more server queued entries | Activate | DELETE each queue ID; chip clears only after confirmation | Failed delete keeps chip; queue landing racing delete is consumed once and no ghost reappears | `server/steer-queue.test.ts`, store tests | P0 | Manual — executable |
| WS-CMP-014 | Crew busy composer | First held direction | Crew member active | Send | Direction is held locally with complete draft snapshot and “Held next” status; no immediate group POST | Component unmount restores draft; changing selected run does not dispatch it to another run | Composer source + browser race trace | P0 | Manual — executable |
| WS-CMP-015 | Crew busy composer | Second send while one held | Existing held crew direction | Type more text | Send control remains disabled for held slot; newer text stays editable and does not replace first | Clearing held direction restores ability; no silent text loss | Component trace | P0 | Manual — executable |
| WS-CMP-016 | Crew held direction | Busy settles | Held direction exists, same group/thread still active | Complete active turn | Held payload dispatches once to `/api/groups/:id/messages` with original `sendId`, reply and thread; chip clears | If image support changed, group/run switched or request fails, full draft restores and no wrong-thread send occurs | Composer effect + group route integration | P0 | Manual — executable |
| WS-CMP-017 | Composer | “Stop the active step” | Direct or crew busy | Activate | Exact active thread is passed to interrupt route; queued future work is dropped according to service contract; gates close | Stale `threadId` receives 409 and new run remains untouched; repeated stop is safe | Server interrupt/task tests | P0 | Manual — executable |
| WS-CMP-018 | Permission selector | “Gate each action” trigger | Direct workstream, `autoApprove=false` | Open menu | Menu named for operator; current option has `aria-checked`; focus enters first radio item | Escape/outside click closes and returns focus; crew with mixed members follows selected auto-control contract | Component keyboard trace | P1 | Manual — executable |
| WS-CMP-019 | Permission selector | “Gate each action” option | `autoApprove=true` | Select | PATCH persists `autoApprove=false`; trigger copy and icon update | API failure rolls controlled state back via patch queue and reports error | `src/state/bot-patch-queue.test.ts` | P0 | Manual — executable |
| WS-CMP-020 | Permission selector | “Within limits” option | Non-local workbench | Select | PATCH persists `autoApprove=true`; sensitive/destructive provider actions still may gate by policy | Malformed API calls without boolean are 400 | Server auto-approve tests | P0 | Manual — executable |
| WS-CMP-021 | Permission selector | “Within limits” on local Mac | Local workbench, not previously granted | Select then confirm warning | Warning explains consequence; only explicit confirm sends `acknowledgeLocalAuto=true`; cancel keeps gated mode | Direct API without acknowledgement is 400; keyboard focus is trapped and restored | `server/index.test.ts` local-auto cases | P0 | Manual — executable |
| WS-CMP-022 | Crew composer | `@` mention picker | Forge Line active | Type `@r` | Listbox opens with matching active crew members; combobox exposes expanded/controls/active-descendant | Archived/non-member/currently invalid targets omitted; empty candidate list never modulo-divides or steals Enter | Browser component test | P1 | Manual — executable |
| WS-CMP-023 | Crew mention picker | ArrowUp/Down, Enter, Tab | Picker open | Navigate and select Rivet | Highlight wraps predictably; selected text becomes `@Rivet ` at caret; focus remains editor | IME composition and mouse hover preserve correct selection | Keyboard trace | P1 | Manual — executable |
| WS-CMP-024 | Crew mention picker | Escape | Picker open | Press Escape | Picker closes for current `@` position while text remains; later edit/new mention may reopen | Escape while dictating follows dictation case after picker closure | Browser trace | P1 | Manual — executable |
| WS-CMP-025 | Crew composer | `@everyone` | Crew permits everyone routing | Select crew-call option and send | Exact mention is inserted; server dispatches configured responder set once each | Archived members cannot respond; no active responders yields explicit record, not success | `server/index.test.ts` group-turn cases | P0 | Manual — executable |
| WS-CMP-026 | Composer | “Add an artifact to this run” | Desktop file picker available | Choose ordered valid files | Chips appear in picker order; same file may be selected again because input resets | Cancel leaves state; mix of accepted/rejected files keeps accepted in order and announces one precise notice | `src/lib/composer-attachments.test.ts` | P1 | Manual — executable |
| WS-CMP-027 | Window | Drag files | Composer mounted | Drag across nested elements then drop | One assertive intake overlay remains until final leave/drop; drop prevents browser navigation and uses same intake/order as picker | Non-file drag ignored; unmount during async intake performs no state update | Component/manual drag trace | P1 | Manual — executable |
| WS-CMP-028 | Composer | Paste long text | Text exceeds long-paste threshold | Paste at selection | Selection is removed and text becomes EXCERPT chip with line/size summary; composer stays concise | Short paste remains inline; multiple pastes preserve order | `src/lib/composer-attachments.test.ts` | P1 | Manual — executable |
| WS-CMP-029 | EXCERPT chip | “Move pasted excerpt into run editor” | Excerpt attached | Activate | Text appends to editor, chip is removed, editor regains focus at end | Existing text gets correct separator; no duplicate after double click | Helper unit + browser trace | P1 | Manual — executable |
| WS-CMP-030 | Artifact chip | “Remove <name> from this run” | File/image/excerpt chip | Activate for each kind | Only selected attachment leaves draft; remaining order and text unchanged | Keyboard focus can reach hover-revealed button; duplicate filenames remove by ID, not name | Attachment unit + accessibility snapshot | P1 | Manual — executable |
| WS-CMP-031 | Composer image intake | Paste/drop supported image | Rivet supports images | Add PNG/JPEG | Raw bytes upload to `POST /api/attachments`; generated safe path returned; valid image chip/preview appears | Unsupported declared MIME, empty or over-limit bytes are rejected; MIME-spoofed/corrupt bytes may store but must fail inertly in the image decoder under `nosniff`, never execute | `server/attachments.test.ts`, `server/composer-attachments.test.ts` | P0 | Manual — executable |
| WS-CMP-032 | Composer image intake | Image with unsupported target | Cairn or crew routing includes non-image target | Add/send | UI rejects before send with “selected operator cannot inspect image artifacts”; full draft remains | Changing routing after queue but before drain revalidates and restores | Composer source + route harness | P0 | Manual — executable |
| WS-CMP-033 | Composer image chip | “Inspect <name>” | Valid image chip | Activate | Preview dialog opens and traps focus | Broken image shows actionable unavailable state, never an empty modal | Attachment dialog trace | P1 | Manual — executable |
| WS-CMP-034 | Artifact notice | “Dismiss artifact notice” | Intake warning visible | Activate | Notice clears without removing accepted artifacts or draft | New independent failure can show a new notice | Component trace | P2 | Manual — executable |
| WS-CMP-035 | Dictation | “Start dictation” | macOS bridge and permissions available; idle/empty composer | Activate, speak, stop | Partial transcript updates editor; final remains editable; button label changes; no automatic send | Escape stops; active run/content hides button; cleanup stops bridge on unmount | Voice suite owns bridge; composer integration trace | P1 | Manual — executable |
| WS-CMP-036 | Dictation | Unavailable/denied/error | Unsupported build or permission denied | Invoke via controlled bridge fixture | Alert gives exact platform/permission recovery and dismiss button; draft remains | Raw native error and old vocabulary never display | Component bridge fixture | P1 | Manual — executable |
| WS-CMP-037 | Composer | Pending gate takeover | One or more active-path gates | Observe | Textarea disabled with “Resolve the gate above”; oldest unresolved gate and decisions replace normal flow | Gate on inactive branch does not block; answered/dismissed gate releases composer | PendingApproval unit + branching trace | P0 | Manual — executable |
| WS-CMP-038 | Composer | Crew setup lock | `CREW-NEW` | Inspect and try typing/sending | Textarea disabled with “Complete crew setup…”; attachment/permission/send controls absent | Saving or skipping setup unlocks once; first-message 409 prevents bypass | `server/index.test.ts` setup cases | P0 | Manual — executable |
| WS-CMP-039 | Composer | Reply consumed on send | Reply selected, valid send | Send | Reply UI clears after snapshot; receipt/message retains correct `replyToId` | Failed send restores quote with failed snapshot; current different reply is not overwritten | `src/lib/replies.test.ts`, drafts tests | P0 | Manual — executable |
| WS-CMP-040 | Composer | Restart/reconnect with unsent draft | Draft and chips stored; app process restarts | Relaunch same profile | Exact run-scoped draft and safe local artifact references restore; no automatic dispatch | Missing local file renders/removes safely; credential values are never part of draft storage | Draft persistence test + manual restart | P0 | Manual — executable |

## Run ledger and run lifecycle

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-RUN-001 | Single-run header | “Start a fresh run” | Idle, exactly one run | Activate | `POST /api/bots/:id/tasks {}` returns 201; new run becomes active with empty transcript and independent draft; bot SSE announces current state | Busy disables with named reason; repeated request creates explicit separate runs, never aliases thread ID | `server/tasks.test.ts` | P0 | Manual — executable |
| WS-RUN-002 | Run ledger footer | “Start a fresh run” | Multiple runs, idle | Activate | Same create contract; ledger closes; new active run displayed | Network failure keeps existing run selected and reports error | `server/tasks.test.ts`; manual | P0 | Manual — executable |
| WS-RUN-003 | Run ledger search | “Find a run by title” | 10 named runs | Type mixed-case prefix | Prefix matches precede substring matches, original recency within tier; count label updates | Whitespace clears filter; no match shows concrete empty state | `src/components/TaskPicker.test.ts` | P1 | Manual — executable |
| WS-RUN-004 | Run ledger search | Enter | Filter has matches | Press Enter | First visible match switches if needed, then ledger closes | No matches does nothing; IME Enter does not switch | `TaskPicker.test.ts`; keyboard trace | P1 | Manual — executable |
| WS-RUN-005 | Run ledger search | ArrowDown/ArrowUp | Search focused | Press keys | Focus moves to first/last visible run choice | Empty result retains focus safely | Keyboard manual | P1 | Manual — executable |
| WS-RUN-006 | Run choice | Click | Idle, inactive run | Click once | `POST /api/bots/:id/tasks/:threadId`; bot+messages+active leaf hydrate atomically; menu lingers only configured 500 ms then closes | Active click causes no request; busy server 409 leaves current transcript | `server/tasks.test.ts`, `TaskPicker.test.ts` | P0 | Manual — executable |
| WS-RUN-007 | Run choice | Arrow/Home/End | Choice focused | Navigate | Focus wraps Up/Down and jumps first/last with Home/End; no selection until activation | Filter changes do not focus removed DOM | Browser keyboard trace | P1 | Manual — executable |
| WS-RUN-008 | Run row | Double-click | Idle | Double-click title | Rename input opens; select does not fire from detail≥2; current run stays active | Fast first click's dismiss timer is cancelled | `src/components/TaskPicker.test.ts` | P1 | Manual — executable |
| WS-RUN-009 | Run row | Context menu | Idle | Right-click title | Native menu suppressed; rename input opens | Keyboard has dedicated rename button equivalent | `TaskPicker.test.ts` | P1 | Manual — executable |
| WS-RUN-010 | Run row | “Rename run …” | Idle | Activate, type valid ≤80-character title, Enter | PATCH persists normalized title; input closes; run/thread unchanged | Whitespace/no-op does not send; IME Enter waits; server missing run 404 | `TaskPicker.test.ts`, `server/tasks.test.ts` | P1 | Manual — executable |
| WS-RUN-011 | Rename input | Escape | Draft changed | Press Escape | Original title remains; blur caused by unmount cannot save | Focus returns within ledger | `TaskPicker.test.ts` | P1 | Manual — executable |
| WS-RUN-012 | Rename input | Blur | Valid changed title | Click another safe ledger control | Commit happens once through `nextRename`; no duplicate request from Enter+blur | Empty normalizes to no-op | Rename tests | P1 | Manual — executable |
| WS-RUN-013 | Run row | “Remove run …” | At least two runs; target inactive | Activate | Inline confirmation appears with exact title and transcript consequence; Keep gets autofocus | No deletion before explicit Remove | Component trace | P0 | Manual — executable |
| WS-RUN-014 | Delete confirmation | “Keep run” | Confirmation open | Activate | Confirmation closes; run/transcript/provider session untouched | Escape at ledger level also closes safely | Manual request assertion | P0 | Manual — executable |
| WS-RUN-015 | Delete confirmation | “Remove run” | At least two, target idle | Activate | DELETE removes run, transcript and provider session; response atomically selects valid remaining run; live update reaches other clients | Last run returns 400; unknown returns appropriate error; no orphan SQLite/events rows | `server/tasks.test.ts`, `server/message-db.test.ts` | P0 | Manual — executable |
| WS-RUN-016 | Active run delete | Remove control | Active provider/cadence run | Inspect/attempt | UI disables active delete; direct API returns 409 “Stop it first”; no deletion | Settling race must recheck at server | `server/tasks.test.ts`, routines tests | P0 | Manual — executable |
| WS-RUN-017 | Run switch/create/delete | Pending gate exists | `RUN-GATE` active | Attempt mutation | Consequential mutation is blocked where service contract requires; gate remains answerable and transcript unchanged | Gate on unrelated inactive run must not block safe owner operations unless route deliberately scans all crew tasks | Group/bot task integration | P0 | Manual — executable |
| WS-RUN-018 | Crew run lifecycle | New/switch/rename/delete | Forge Line idle | Perform each | Mirrors direct run behavior via `/api/groups/:id/tasks`; full crew transcript/pin/folder state hydrates atomically | DM crew rejects; busy or unresolved option card returns 409; crew retains one run | `server/group-tasks.test.ts` | P0 | Manual — executable |
| WS-RUN-019 | Run usage | Row tally/title | Usage present | Inspect and hover | Combined formatted total visible; exact input/output title; zero/missing omitted | Large values format without overflow at all widths | Format-token unit + screenshot | P2 | Manual — executable |
| WS-RUN-020 | Restart | Active run persistence | Multiple runs and branches | Restart server/app | Same active run, titles, messages, active leaf, pin, usage and drafts restore | Corrupt/missing one transcript fails closed with controlled error; other runs remain | Store/message DB tests + restart harness | P0 | Manual — executable |

## Crew creation, setup, routing, roster, bearing, and record parity

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-CRW-001 | Crew creation surface | Operator checkbox row | ≥2 active operators | Toggle Rivet/Cairn with pointer and Space | `role=checkbox` and `aria-checked` follow selection; label changes Add/Remove; order follows roster | Archived operators absent; unknown IDs ignored server-side; zero selection disables creation | `src/lib/room-members.test.ts`; `server/index.test.ts` | P1 | Manual — executable |
| WS-CRW-002 | Crew creation | Empty available roster | No active operators | Open picker | Named status explains no operators available and gives concrete creation action | No empty checkbox group or inaccessible dead end | Accessibility snapshot | P1 | Manual — executable |
| WS-CRW-003 | `POST /api/groups` | Create crew | Two valid members | Submit name/section/members | 201 returns crew with empty messages and one run; roster deduplicates preserving first order; default name is first operator “& co.” | Non-object, unknown member, zero members, >100 name, >60 section return 400 and create nothing | `server/index.test.ts` | P0 | Manual — executable |
| WS-CRW-004 | Crew first open | Setup screen | `CREW-NEW` | Select crew | Setup replaces transcript/composer; Workbench root, routing choices, lead selector and Crew directive are labelled | DM and legacy usable crew skip this setup; no message can be sent underneath | `server/index.test.ts`; component snapshot | P0 | Manual — executable |
| WS-CRW-005 | Crew setup | Workbench root input | Setup open | Enter valid absolute path | Draft remains local until Set bearing; displayed path is not pinned yet | Relative, home/refused, overlong or wrong type produces controlled error and no partial setup | Room CWD tests | P0 | Manual — executable |
| WS-CRW-006 | Crew setup desktop | “Set ground” picker | Desktop bridge available | Choose folder | Exact normalized path populates field; cancel keeps prior draft | Bridge error produces alert and controls re-enable | GroupView/manual | P1 | Manual — executable |
| WS-CRW-007 | Crew setup | Routing choices | Two members | Select Lead, Full crew, Named only | Radio state and explanatory copy update; Lead shows member select; submitted responder matches selection | Removed/unknown lead is rejected and UI refreshes roster | `src/lib/group-routing.test.ts`; server setup tests | P0 | Manual — executable |
| WS-CRW-008 | Crew setup | “Set bearing” | Valid setup | Activate once and rapidly twice | PATCH `action=complete`; setup, cwd, bulletin and responder persist atomically; composer unlocks | Controls disable while saving; duplicate receives existing completed state; no second mutation | `server/index.test.ts` | P0 | Manual — executable |
| WS-CRW-009 | Crew setup | “Open without a bearing” | Empty new crew | Activate | PATCH `action=skip`; skip marker persists; workstream opens with usable composer | First-message race before skip/complete returns 409 | `server/index.test.ts` | P0 | Manual — executable |
| WS-CRW-010 | Crew setup | Failure | Inject 400/500 | Submit | Inline `role=alert`; all drafted values remain; buttons re-enable | No partial setup fields or stranded lock | Browser network injection | P0 | Manual — executable |
| WS-CRW-011 | Crew masthead | Roster button “Edit crew roster …” | Setup complete, non-DM | Activate | Modal named “Manage roster for Forge Line” opens, focuses inside and reflects selected members | Focus trapped; Escape/backdrop/close restores trigger; background inert | ManageMembersPanel trace | P1 | Manual — executable |
| WS-CRW-012 | Roster modal | Member toggles and Save | At least one checked | Remove lead, add member, save | PATCH member IDs; remaining/new lead repairs deterministically; masthead sigils and routing update | Save disabled at zero; unknown, duplicate, active-turn or gate race fails without optimistic stale roster | `room-members.test.ts`, `server/index.test.ts` | P0 | Manual — executable |
| WS-CRW-013 | Roster modal | Cancel/close | Dirty selection | Close without save | Existing crew roster and lead unchanged | No PATCH; reopen shows persisted state | Browser request assertion | P1 | Manual — executable |
| WS-CRW-014 | Crew routing selector | Lead operator option | Idle crew | Select Cairn | Optimistic label updates; PATCH persists exact member ID; unmentioned sends route only to Cairn | API failure reconciles; removed lead falls back to current first member | `group-routing.test.ts`, server group tests | P0 | Manual — executable |
| WS-CRW-015 | Crew routing selector | “Full crew mobilizes” | Idle | Select then send unmentioned direction | All active, nonhidden members receive ordered turns; header/presence identifies current member | One member failure/timeout is recorded; no duplicate responders | Server group turn/timeout tests | P0 | Manual — executable |
| WS-CRW-016 | Crew routing selector | “Named operators only” | Idle | Select; send no mention, then `@Rivet` | Unmentioned request produces explicit no-responder/mention guidance; mentioned request reaches only Rivet | Hidden/nonmember mention is ignored/rejected safely | `group-routing.test.ts`; index tests | P0 | Manual — executable |
| WS-CRW-017 | Standing brief | “Brief” / edit textarea | Setup complete | Open, edit, Cmd/Ctrl+Enter | PATCH persists `bulletin`; collapsed first line updates and all future member turn context sees exact brief | Blur saves once; unchanged closes without request; Escape restores original | GroupView + server turn-context test | P1 | Manual — executable |
| WS-CRW-018 | Standing brief | Over-limit/wrong type | Direct API or 12,001 chars | Save | 400; existing brief retained; visible error controlled | Multi-byte boundary measured against route's character contract exactly | `server/index.test.ts` | P1 | Manual — executable |
| WS-CRW-019 | Crew workbench chip | “Set crew workbench” | No pin, setup complete | Open editor, bind valid path | Nonoptimistic PATCH succeeds, chip names basename/full path; new runs use bearing | Cancel picker/no edit makes no mutation; invalid path leaves old value | `server/room-cwd.test.ts` | P0 | Manual — executable |
| WS-CRW-020 | Crew workbench editor | “Use operator grounds” | Bound but not first-turn pinned | Clear path | PATCH null/empty; chip reflects per-operator workbenches | Once first turn pins folder state, PATCH returns 409 and current pin remains | Room CWD/index tests | P0 | Manual — executable |
| WS-CRW-021 | Crew message | “Hold this entry” | Any current-branch record | Activate | PATCH one `pinnedMessageId`; header “Held · sender” appears and exact record jumps on activation | Invalid ID format 400; missing/off-branch ID resolves to no banner, no crash | Server pin tests + UI trace | P1 | Manual — executable |
| WS-CRW-022 | Held banner | “Release held entry” | Held record | Activate from banner and record | Pin clears via PATCH; both controls update | Duplicate clear is safe | Server + trace | P1 | Manual — executable |
| WS-CRW-023 | Crew transcript | Role/kind render matrix | Fixtures for user, operator, reply, gate, secret, connector, cadence, activity, error | Render each | Sender clustering/day boundaries are correct; replies/pins/marks/actions remain operable; running tool calls honor preference but failures stay visible | No raw unsupported kind may disappear silently: ordinary question/options, webhook and screen fixtures must either render an accountable plate or fail this case | GroupView source audit; new E2E required | P0 | Manual — executable |
| WS-CRW-024 | Crew record actions | Reply, hold/release, marks | Both user and operator records | Keyboard through each | All have visible focus, correct accessible names and correct thread/message IDs | Crew intentionally has no revise/run-again/copy/speak/branch control; no invisible hover-only timestamp is accepted for keyboard users | Accessibility snapshot; defect gate | P1 | Manual — executable |
| WS-CRW-025 | Crew empty workstream | Initial empty-state render | Setup-complete crew has no records | Open the crew | “Set the first run in motion” plus assigned sigils and routing-specific concrete hint; composer ready | No generic empty copy, stale pin, old operator or hidden gate | Visual snapshots at three widths | P1 | Manual — executable |
| WS-CRW-026 | Crew deletion | `DELETE /api/groups/:id` from owning surface | Idle crew with multiple runs | Confirm in owning destructive UI and delete | Crew, all task transcripts, event logs and reply caches are removed; clients receive deletion; selection falls back safely | Busy returns 409; unknown 404; direct API cannot leave event files/orphan transcript rows | `server/index.test.ts`, message DB tests | P0 | Manual — executable |
| WS-CRW-027 | Direct-message crew | Fixed-pair workstream | DM fixture | Inspect and attempt tasks/roster/folder/setup mutations | Static pair sigils render; no run picker/setup/folder/roster editor; APIs reject task, roster and folder changes | Ordinary message/reply/gate/interrupt remains usable on canonical thread | `server/index.test.ts` DM cases | P0 | Manual — executable |
| WS-CRW-028 | Crew busy state | Busy member sigil/presence | Cairn speaking | Observe header and record tail | Cairn is named “moving the run,” Rivet “standing by”; presence and interrupt target current member/thread | Member handoff, timeout and reconnect cannot show two speakers busy | Member-turn/timeout tests + manual | P1 | Manual — executable |

## Gates, opening briefs, questions, credentials, and consequential decisions

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-GAT-001 | Transcript Gate card | Pending method request | `GATE-SHELL` | Inspect | Requester, requested action, exact resource, consequence, method and held reason are all visible before controls; status says Decision required | Long resource scrolls and is keyboard focusable; no command truncation or secret interpolation | `src/components/ApprovalCard.test.ts` | P0 | Manual — executable |
| WS-GAT-002 | Composer Gate takeover | Multiple pending gates | `RUN-GATE` | Inspect | Oldest active-path unresolved gate shown as “Gate 1 of 2”; composer disabled | Answering first reveals second; inactive-branch/orphan card does not block | Peer approval + branching tests | P0 | Manual — executable |
| WS-GAT-003 | Gate decisions | “Allow once” | Pending normal gate | Activate once/double | POST `/api/threads/:thread/respond` behavior `allow`; provider receives one decision; card patches “Allowed once”; run resumes; composer releases if no next gate | Duplicate/stale request returns controlled unavailable outcome and never executes twice | `server/index.test.ts`, Claude driver tests | P0 | Manual — executable |
| WS-GAT-004 | Gate decisions | “Deny request” | Pending gate | Activate | POST behavior `deny` with user-denied message; provider sees deny; card says Gate denied; run settles/continues per provider | No method execution or persistent grant | `server/peer-approval.test.ts`, Claude tests | P0 | Manual — executable |
| WS-GAT-005 | Gate decisions | “Stop run” | Pending non-cadence gate | Activate | Correct direct/crew interrupt route; pending approvals close; run/queue settles; card no longer blocks composer | Repeated/stale stop cannot affect newly active thread | Index interrupt tests | P0 | Manual — executable |
| WS-GAT-006 | Gate decisions | “Grant options” disclosure | Gate has trusted `allowKey` and owner | Expand | Narrow exact key and requester shown; persistent action progressively disclosed | No disclosure/control when owner or key absent; Escape/focus remains usable | PendingApproval snapshot/manual | P0 | Manual — executable |
| WS-GAT-007 | Grant options | “Always allow <key>” | Valid pending key | Activate | PATCH adds deduplicated key (max 200) before respond; current request allowed; later exact-key request proceeds within policy | Different command/resource/owner still gates; PATCH failure is announced and current one-off response does not strand run | `server/auto-approve.test.ts`, peer approval tests | P0 | Manual — executable |
| WS-GAT-008 | Grant API | `/api/bots/:id/always-allow` or broad patch | No matching pending gate | Forge arbitrary key | Server returns 409 for dedicated route or validates list; no privilege grant | Wrong type 400, duplicates dedupe, cap enforced | Server index/auto-approve tests | P0 | Manual — executable |
| WS-GAT-009 | Cadence gate | Create/update/pause/resume/run-now/delete | One fixture each | Inspect | Exact schedule/instructions and correct consequence; buttons say specific action and “Keep current cadence”; no generic shell grant/Stop/Always UI | “Run now” says queued, not already started; cadence copy never says legacy routine | ApprovalCard tests + cadence tests | P0 | Manual — executable |
| WS-GAT-010 | Cadence gate | Apply/keep | Pending cadence change | Decide each path | Trusted operation is applied only after allow; denial leaves current cadence; settled card uses precise result | Replay of request ID cannot apply twice | Routine request tests | P0 | Manual — executable |
| WS-GAT-011 | Question gate | Provider free-text question | Pending `request.opened` question | Enter and submit answer in owning question UI | POST behavior `answer` with exact text; provider receives once; card settles and composer unblocks | Empty/oversize answer disabled/rejected; stale ID no mutation | Claude driver and index respond tests; UI E2E required | P0 | Manual — executable |
| WS-GAT-012 | Option question | Provider choices | Pending options with request ID | Choose each option in isolated run | Exact selected option sent as answer; selection disables after settle; response persists | Rapid two-option clicks produce one outcome; no onboarding-card route confusion | Claude question tests; new UI E2E | P0 | Manual — executable |
| WS-GAT-013 | Opening brief | Suggested option | Onboarding card without request ID | Activate option | Card `answered`/`dismissed` persists; same text is sent as first direction; later user line hides brief | Retry does not send two turns; answered card stays hidden after restart | `src/components/OptionCard.test.ts`, index card test | P1 | Manual — executable |
| WS-GAT-014 | Opening brief | “Different direction” | No card tool, unanswered | Enter custom text and submit | Trimmed text follows same persist-and-send contract; empty disables | Tool/permission card never exposes free-text onboarding field | OptionCard tests + manual | P1 | Manual — executable |
| WS-GAT-015 | Opening brief | “Dismiss this opening brief” | Unanswered | Activate | PATCH dismissed; no direction sent; card stays hidden after restart | Later permission/question cards are never hidden by onboarding helper | OptionCard tests | P1 | Manual — executable |
| WS-GAT-016 | Credential gate | Initial waiting state | `CRED-KEY` | Inspect | Label, requester, action, consequence, password field, local-storage assurance, help link and Decline are present | Accessible description never contains value; input has `autocomplete=new-password` and spellcheck off | New SecretRequestCard E2E | P0 | Manual — executable |
| WS-GAT-017 | Credential gate | “Store and continue” | Disposable OS credential bridge | Enter `qa-secret-42` and submit | Bridge stores locally; UI immediately clears value; config status updates; POST `/provided` contains thread only; card resumes; transcript/SSE/log/request evidence contain zero occurrences of value | Double submit disabled; whitespace-only disabled; credential never sent to server config when secure bridge exists | Credential request tests + secret-leak scan | P0 | Manual — executable |
| WS-GAT-018 | Credential fallback | No desktop credential bridge | Development shell only | Submit disposable key | PUT `/api/config` uses mapped known credential field; status updates; `/provided` verifies configured state without echo | Unknown credential target rejected; production desktop must prefer OS bridge | `server/credential-request.test.ts` | P0 | Manual — executable |
| WS-GAT-019 | Credential gate | “Decline gate” | Pending, not provided | Activate | POST `/dismiss`; card outcome persists and paused continuation settles without credential | Dismiss racing save has one final outcome; provided credential is never erased by dismiss | Credential request/index continuation tests | P0 | Manual — executable |
| WS-GAT-020 | Credential gate | Save cancelled/fails | OS bridge cancel/error | Submit | Password remains only as necessary for retry or is safely cleared per bridge contract; controlled alert shown; `/provided` not called | Error/log contains no value; button re-enables | New bridge fault-injection E2E | P0 | Manual — executable |
| WS-GAT-021 | Credential API | `/provided` before save | Credential not configured | POST thread/card | 409 “was not saved yet”; card remains pending; no continuation | Wrong bot/thread/message 404; dismissed 409 | Route integration to add | P0 | Manual — executable |
| WS-GAT-022 | Credential API/UI | Resume failure after local save | Save succeeds, provider continuation fails | Observe then “Retry resume” | Card says stored but run did not resume; retry calls `/resume` without credential and eventually resumes once | Removed credential makes `/resume` 409 “no longer configured”; no re-prompt leak | Credential route tests to add + UI E2E | P0 | Manual — executable |
| WS-GAT-023 | Credential help | “Find this credential” | HTTPS help URL | Activate | Opens external browser with `noopener noreferrer`; workstream stays | Non-HTTPS/malformed URL is blocked/sanitized by shell policy | Electron URL tests + manual | P1 | Manual — executable |
| WS-GAT-024 | Settled Gate card | Allow/deny/unavailable | One of each | Inspect/reload | Explicit icon+text status persists; decision controls absent; exact resource remains audit-visible | Restart cannot resurrect resolved gate | Store/message DB + ApprovalCard tests | P0 | Manual — executable |
| WS-GAT-025 | Gate ownership | Crew member request after turn ends | Durable crew card, no busy member | Decide | Owner falls back to card sender; request answers or closes; crew never remains permanently composer-locked | Deleted sender closes unreachable card safely | Index “answers a room approval…” | P0 | Manual — executable |
| WS-GAT-026 | Gate ownership | Peer communication request | Peer approval card | Allow and deny separately | Approval bus resolves exact request; composer unblocks; target receives only allowed dispatch | Unknown ID falls through safely; deletion/interrupt cancels | `server/peer-approval.test.ts` | P0 | Manual — executable |
| WS-GAT-027 | Gate restart | Pending active/inactive-run cards | Restart server | Hydrate | Live active card remains; stale inactive task/orphan prior-run card dismisses; user can always continue | No ghost pending card in composer after restart | Peer approval tests | P0 | Manual — executable |
| WS-GAT-028 | Gate timeout | Pending human decision | Crew timeout active | Wait beyond ordinary turn budget, then decide | Timeout pauses while human decision open and resumes with remaining budget after resolution | Multiple approvals and expired-on-open handled once; no timeout during genuine user wait | `server/room-turn-timeout.test.ts` | P0 | Manual — executable |
| WS-GAT-029 | Gate accessibility | Gate panel/action group | Pending gate | Keyboard/screen reader traverse | Logical order: title, method, action, resource, consequence, requester, reason, Stop/Deny/Grant/Allow; names/states announced; visible focus | 390 wraps without reordering; 200–400% zoom keeps exact command scrollable | Accessibility snapshots at widths | P1 | Manual — executable |
| WS-GAT-030 | Credential privacy | Transcript/export/search/SSE/log | Save `qa-secret-42` | Complete, search, export JSON/MD, inspect DB/event logs | Zero secret occurrences; only target/label/outcome metadata persist; OS store holds value | Crash/reconnect and error telemetry also contain zero value | `server/store.test.ts` redaction + explicit repository temp-dir scan | P0 | Manual — executable |

## REST and live-event contract inventory

This table is the route manifest for this QA domain. A route is not certified by a UI case alone; send it directly with valid, malformed, stale, duplicate and concurrent inputs. JSON mutation requests use `content-type: application/json`. Generated IDs are URL-encoded by the client.

Before every route-specific assertion, verify the shared boundary: only loopback Host and browser Origin are accepted; internal routes require the per-boot constant-time bearer; JSON bodies above 1,000,000 bytes return 413, invalid JSON returns 400, unexpected failures return a bounded `{error}` with the intended status, and an unknown route returns 404. These checks are automated in `server/index.test.ts` and must also be present in the proxy/companion suites that expose a deliberate subset of the routes below.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-API-001 | `GET /api/events` | EventSource connect | Seeded workspace | Connect without cursor | 200 event stream; first `hello` includes current cursor and `resumed:false`; subsequent wanted frames are ordered and heartbeat keeps connection alive | Invalid/expired cursor causes honest non-resume; disconnect removes client; response never caches/buffers | `server/index.test.ts`, `src/lib/live-events.test.ts` | P0 | Automated — passing |
| WS-API-002 | `GET /api/events?since=` | Reconnect/replay | Cursor inside replay window | Reconnect with query and separately `Last-Event-ID` | Valid browser cursor takes precedence; all later frames replay exactly once, then live continues | Cursor gap returns `resumed:false`, requiring snapshot; malformed cursor ignored safely | Event replay tests | P0 | Automated — passing |
| WS-API-003 | `GET /api/bots?messages=N` | Initial/repair hydration | Operators and crews seeded | Request no parameter, N=0, 50 and 200 | No parameter returns complete transcripts for compatibility; N returns newest bounded page; public operators/crews include active runs/leaves and computer control; provider cursors/credentials are absent | N over 200 clamps; negative/fraction/non-numeric 400; hidden/internal provider secrets absent | `server/index.test.ts`, store hydration tests | P0 | Automated — passing |
| WS-API-004 | `GET /api/threads/:thread/messages` | Transcript pagination | Valid direct and crew threads | Request default and `limit=0` | Newest page, `hasMore`, branch-aware records and stable ordering | Unknown conversation 404; invalid limit 400 | Index message-page tests | P0 | Automated — passing |
| WS-API-005 | `GET /api/threads/:thread/messages?before=:id` | Earlier records | Known cursor | Page backward to start | Records immediately before cursor without overlap; hasMore eventually false | Unknown cursor 404 rather than newest-page loop; before+around 400 | Index pagination tests | P0 | Automated — passing |
| WS-API-006 | `GET /api/threads/:thread/messages?around=:id` | Search/pin landing | Target outside tail | Request bounded around window | Target is present with balanced bounded context and ownership intact | Unknown message/thread 404; invalid size 400 | Index pagination/window tests | P0 | Automated — passing |
| WS-API-007 | `GET /api/threads/:thread/messages/:id/image` | Screen record pixels | Message has PNG | Fetch | Exact bytes/MIME; private immutable cache; no base64 JSON | Unknown thread/message or no image 404; cannot materialize arbitrary thread state | Index image cases | P1 | Automated — passing |
| WS-API-008 | `POST /api/attachments` | Image intake | Raw supported bytes | Send each allowed MIME at/below limit | 201 generated safe basename/path; bytes persist mode 0600 inside mode-0700 directory | Missing/unsupported MIME or empty 400; oversize 413; claimed MIME is intentionally not sniffed, so spoofed bytes must remain inert under the GET `nosniff`/image decode boundary | `server/attachments.test.ts` | P0 | Automated — passing |
| WS-API-009 | `GET /api/attachments/:name` | Preview/download | Issued attachment | Fetch | Exact bytes/MIME; `nosniff`; private immutable cache | Traversal, dotfile, unissued, wrong extension, malformed name 404 | `server/attachments.test.ts` | P0 | Automated — passing |
| WS-API-010 | `GET /api/search` | Global search | Indexed direct/crew records | Query with default/1/40/100 limit | Case-insensitive literal search; wildcard chars escaped; accurate snippet offsets, role/kind/source/run and `onActivePath` | Empty query behavior bounded; limit clamps 1–100; deleted owners omitted | `server/message-db.test.ts`, index search test | P1 | Automated — passing |
| WS-API-011 | `GET /api/search?threadId=` | Find in workstream | Known thread | Search exact phrase/tool | Results only from given thread and correct branch metadata | Unknown thread 404; no cross-run/crew data | Index search tests | P0 | Automated — passing |
| WS-API-012 | `GET /api/threads/:thread/export?format={markdown,json}` | Export | Thread with branches/cards | Export each | Only visible active path; safe filename/title; JSON strips pixels; Markdown uses Helmryth-readable records | Unknown thread 404; other format 400; credential values/redacted payload absent | Index export test + privacy scan | P0 | Automated — passing |
| WS-API-013 | `POST /api/groups` | Create crew | Valid members | Send minimal and fully setup object | 201 durable crew; fully setup form is atomic and MCP-ready | Null/array/wrong types, unknown/empty member, duplicate normalization, length boundaries are enforced atomically | `server/index.test.ts` | P0 | Automated — passing |
| WS-API-014 | `PATCH /api/groups/:id/setup` | Complete/skip setup | New empty crew | Send `complete`, `skip`, then duplicate | First valid action persists marker and config; duplicate returns unchanged 200 | DM 400; invalid action/body/cwd/responder/bulletin 400; messages already exist 409 | Index setup tests | P0 | Automated — passing |
| WS-API-015 | `POST /api/groups/:id/tasks` | New crew run | Idle standard crew | Send `{}` or title | 201 task and full current crew; group SSE | DM/missing/working/open card/nonobject/wrong title blocked; no task created | `server/group-tasks.test.ts`, index tests | P0 | Automated — passing |
| WS-API-016 | `POST /api/groups/:id/tasks/:thread` | Switch crew run | Idle | Switch, with and without `messages=0` | 200 current crew, correct transcript/pin/folder/tasks; group SSE | Missing/DM/busy/open gate/unknown run error with old run unchanged | Group task/index tests | P0 | Automated — passing |
| WS-API-017 | `PATCH /api/groups/:id/tasks/:thread` | Rename crew run | Idle | Send title boundaries | 200 normalized task; storage survives restart | Bad body/type, busy/gate, unknown 400/404; existing title safe | Group task/index tests | P1 | Automated — passing |
| WS-API-018 | `DELETE /api/groups/:id/tasks/:thread` | Remove crew run | ≥2, idle | Delete active and inactive separately | 200 full crew; transcript/session removed; valid remaining run selected; group SSE | Final run 400; busy/open gate/DM 409/400; unknown 404 | Group task/index tests | P0 | Automated — passing |
| WS-API-019 | `PATCH /api/groups/:id` | Name/brief/roster/routing/folder/pin/section/unread | Existing crew | Test each field independently and combined | 200 validated public crew; durable intended fields only | Nonobject, wrong types, empty/over-limit, unknown roster, DM roster/folder, busy/gate protected fields, pinned folder change and malformed pin all fail closed | `server/index.test.ts`, room CWD tests | P0 | Automated — passing |
| WS-API-020 | `POST /api/groups/:id/read` | Clear unread compatibility route | Unread crew | Invoke | 200 unread false and group SSE | Unknown 404; no other field changes | Index/store manual request | P2 | Manual — executable |
| WS-API-021 | `DELETE /api/groups/:id` | Delete crew | Idle | Delete | 200; store, transcripts, reply cache and native/event logs removed | Missing 404; working 409; no partial delete | Index/message DB test | P0 | Manual — executable |
| WS-API-022 | `POST /api/groups/:id/messages` | Crew direction | Valid active task | Send text, `sendId`, reply and thread | 202 canonical receipt; user record once; group turn starts according to routing | Empty/nonobject 400; foreign reply; malformed/stale/wrong task 400/409; same ID conflict 409; retry canonical | Index send/reply/idempotency tests | P0 | Automated — passing |
| WS-API-023 | `POST /api/groups/:id/interrupt` | Stop crew run | Busy queued/active/gated crew | Send exact thread body and null body separately | Cancels entire operation before provider await, interrupts speaker, closes approvals, returns 200 | Nonobject/malformed/stale thread 400/409; repeated stop safe | Index interrupt/queued channel tests | P0 | Automated — passing |
| WS-API-024 | `POST /api/threads/:thread/messages/:id/reactions` | Toggle record mark | Existing record | Add/remove same emoji by user and member | 200 patched message; only actor's identical mark toggles; message.patch reaches clients | Empty emoji 400; value truncated to 8 contract; unknown/foreign IDs 404; malformed/null body must not 500 | Store event test; dedicated route E2E required | P0 | Manual — executable |
| WS-API-025 | `PATCH /api/bots/:id` | Workstream pin/profile settings | Existing operator | Patch `pinnedMessageId`, clear and concurrent profile edit | 200 validated operator; patch queue serializes/reconciles; pin persists | Malformed pin/type, missing operator, rejected overlapping patch leave authoritative state | Index pin test, bot-patch queue tests | P0 | Automated — passing |
| WS-API-026 | `POST /api/bots/:id/read` | Clear unread compatibility route | Unread operator | Invoke | 200 unread false and bot SSE | Unknown 404 | Index/manual | P2 | Manual — executable |
| WS-API-027 | `PATCH /api/bots/:id/cards/:message` | Opening brief state | Existing card | Patch answered/dismissed independently | 200 patched message persists and message update propagates | Wrong bot/card 404; wrong types must not corrupt card metadata | Index card test | P1 | Automated — passing |
| WS-API-028 | `POST /api/bots/:id/messages` | Direct direction/steer/queue | Active run owned | Exercise idle, busy steer, busy queue, retry | 202 with canonical/steered/queued receipt; at-most-once by send ID and exact thread | Empty/nonobject, malformed/stale/deleted task, conflicting send ID, late steer and unavailable provider all fail without stray record | Idempotency/steer/index tests | P0 | Automated — passing |
| WS-API-029 | `DELETE /api/bots/:id/queue/:queue` | Cancel queued direction | Existing queued item | Delete and repeat | First 200 removes exact queue; no provider turn; later drain cannot send it | Missing operator/queue 404; wrong operator cannot cancel another queue | `server/steer-queue.test.ts` | P0 | Automated — passing |
| WS-API-030 | `POST /api/bots/:id/messages/:message/edit` | Revise/fork | Idle, valid user text | Send changed text | 202; sibling branch created, active leaf changed, provider reruns with reply context | Empty 400; busy/provider unavailable 409; nonuser/unknown 404; no mutation on failure | `server/branching.test.ts`, index tests | P0 | Automated — passing |
| WS-API-031 | `POST /api/bots/:id/active-branch` | Switch revision | Idle branch tree | Send leaf/message ID | 200 active leaf; provider marked for replay; thread SSE | Busy 409; unknown 404; active state unchanged on rejection | Branching/index tests | P0 | Automated — passing |
| WS-API-032 | `POST /api/bots/:id/respond` | Direct legacy/card answer | Pending request | Send allow/deny/answer | 200 exact outcome; routine/peer/provider request resolves | Invalid behavior 400; stale returns unavailable without execution | Index/driver tests | P0 | Automated — passing |
| WS-API-033 | `POST /api/threads/:thread/respond` | Canonical direct/crew Gate answer | Pending gate/question | Send allow/deny/answer | Correct thread owner/bus/cadence resolves; durable card patches; composer can unblock | Invalid behavior 400; no owner/card 404 where specified; double decision idempotent/unavailable | Peer/routine/index tests | P0 | Automated — passing |
| WS-API-034 | `POST /api/bots/:id/interrupt` | Stop operator/cadence/crew-member run | Busy context | Send exact `threadId` for each ownership mode | Cancels correct cadence, crew or direct turn; gates close | Malformed/stale/wrong-workstream 400/409; must not interrupt newly active run | Index interrupt tests | P0 | Automated — passing |
| WS-API-035 | `POST /api/bots/:id/tasks` | New direct run | Idle operator | Send `{}` / title via API | 201 new active task and full operator; bot SSE | Missing/busy 404/409; creation failure leaves old run | Tasks/index tests | P0 | Automated — passing |
| WS-API-036 | `POST /api/bots/:id/tasks/:thread` | Switch direct run | Idle | Switch with/without messages=0 | 200 full authoritative bot/task state; bot SSE | Busy/unknown 409/404; no active process orphan | Tasks/index tests | P0 | Automated — passing |
| WS-API-037 | `PATCH /api/bots/:id/tasks/:thread` | Rename direct run | Existing | Send empty/valid/80+/Unicode | 200 normalized task and bot SSE | Unknown 404; no transcript identity change | Tasks/index tests | P1 | Automated — passing |
| WS-API-038 | `DELETE /api/bots/:id/tasks/:thread` | Delete direct run | ≥2 | Delete inactive/active idle | 200 full bot; transcript/session removed; remaining selected | Active/cadence thread 409; final/unknown contract 400; no data loss on reject | Tasks tests | P0 | Automated — passing |
| WS-API-039 | `POST /api/bots/:id/secret-cards/:message/provided` | Verify credential and resume | Bound card/thread | Call after secure store write | 200 provided/resumed; value never in body/response | Wrong binding 404; dismissed/not configured 409 | Credential tests + route E2E | P0 | Manual — executable |
| WS-API-040 | `POST /api/bots/:id/secret-cards/:message/resume` | Retry continuation | Exclusive outcome exists | Call | 200 resumed without secret value | Not ready or removed credential 409; repeated safe | Credential tests + route E2E | P0 | Manual — executable |
| WS-API-041 | `POST /api/bots/:id/secret-cards/:message/dismiss` | Decline credential | Pending card | Call twice/race provided | Outcome is durable/idempotent; continuation settles once | Wrong binding 404; already provided outcome not overwritten | Index credential continuation test | P0 | Automated — passing |
| WS-API-042 | `GET /api/threads/:thread/events` | Trace records for workstream | Valid thread, runtime/native NDJSON | Request default, 1 and 2000 | Redacted runtime/native entries merge stably by time; totals accurate; source caps independent | Unknown thread 404; invalid/nonpositive limit 400; traversal/corrupt/torn/schema-invalid lines skipped | `server/thread-events.test.ts` | P0 | Automated — passing |
| WS-API-043 | `GET /api/decisions` | Authorization audit | Gate decisions seeded | Request default and positive limit | Ordered durable decisions include shown/user/auto outcome, rule/source, operator/request/tool/summary without secret | Invalid limit 400; answer-only questions are not falsely logged as authorization | `server/decision-log-wiring.test.ts` | P0 | Automated — passing |
| WS-API-044 | `POST /api/bots/:id/always-allow` | Strict companion grant | Exact pending, non-dismissed gate with key | Send matching key, repeat | 200 operator; key deduplicated/capped 200; later exact request may pass policy | Missing/foreign/different/dismissed/answered key 409; wrong type/empty 400; destructive/local safeguards still override | Companion proxy + auto-approve tests | P0 | Manual — executable |
| WS-API-045 | `POST /api/internal/request-credential` | Provider/harness credential request | Internal bearer, valid owner/thread/allowlisted ID | Request new, duplicate-open and configured target | 201 new safe secret card; 200 reuses eligible card or reports already configured; reason capped 240; no value requested/stored | No token 401/403; invalid ownership 403; unknown target 400; crew reuse scoped to requester | `server/credential-request.test.ts`, index internal auth tests | P0 | Automated — passing |

## Renderer state, persistence, SSE ordering, retry, and recovery

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-STS-001 | StoreProvider startup | Initial SSE hello + REST snapshot | Cold app | Deliver non-resumable hello, delay snapshot, emit message/bot/group/thread frames | Snapshot applies first, buffered frames fold afterward in server order; no lost/duplicate/newer state overwrite | Second non-resumable hello during snapshot triggers one more hydrate pass | Store/live-event tests; provider integration to add | P0 | Manual — executable |
| WS-STS-002 | StoreProvider startup | SSE unavailable | Server REST available | Suppress hello >1 s | Fallback hydration displays saved workstreams; later hello rehydrates honestly | Optional config/routine/webhook failure cannot block chat | `src/state/store.test.ts` | P0 | Automated — passing |
| WS-STS-003 | SSE reconnect | Resumable cursor | Disconnect after frame N | Reconnect and replay N+1… | No full transcript replacement; frames apply once; connected state returns true | Duplicate replay message ignored by ID; cursor commits only after accepted replacement | `src/lib/live-events.test.ts` | P0 | Automated — passing |
| WS-STS-004 | SSE reconnect | Non-resumable cursor | Cursor fell outside buffer | Reconnect | Pending generation clears, REST rehydrates, then queued new frames apply | Old-generation token deltas never leak into new snapshot | Live-events/store tests | P0 | Manual — executable |
| WS-STS-005 | Message receipt | HTTP response then same SSE | Stable send ID | Deliver both orders | Exactly one canonical message, active branch never rewinds, unread/usage state remains authoritative | Same ID with patch is handled by message.patch, not duplicate add | `src/state/store.test.ts` | P0 | Automated — passing |
| WS-STS-006 | Streaming state | Runtime deltas | Busy thread | Emit rapid text/reasoning deltas | Batched at most once per animation frame; ordered text is complete; settled message clears stream after tail flush | Branch switch/thread event clears stale stream; disconnected generation discarded | Store runtime tests + browser performance trace | P1 | Manual — executable |
| WS-STS-007 | Queue receipt | SSE drain before POST queue response | Busy nonsteering operator | Deliver canonical queued message SSE first | Consumed queue tombstone prevents late POST from creating ghost chip; bounded tombstones retain newest 64 | >64 historical receipts still reconcile through hydration scan | `src/state/store.test.ts` | P0 | Automated — passing |
| WS-STS-008 | Queue reload | Undrained server queue | Pending queue, reload renderer | Relaunch | Acceptance target: waiting direction remains visibly accountable or product explicitly blocks release until queue hydration is implemented | Current renderer memory-only chip may disappear until drain; this case is a known release decision, not a pass | State audit; new integration required | P0 | Manual — executable |
| WS-STS-009 | Optimistic operator patch | Pin plus rename/profile edit | Overlapping edits and SSE | Trigger rapidly; inject one failure | Serialized overlay retains later edit; rejected patch rehydrates or restores captured state; deletion cancels lane | No resurrection or lost pin | `src/state/bot-patch-queue.test.ts` | P0 | Automated — passing |
| WS-STS-010 | Optimistic crew patch | Roster/routing/pin/brief | Inject PATCH 409 | Trigger mutation | Acceptance target: visible state rolls back/reconciles and actionable error remains | Current simple optimistic path may diverge until SSE/refresh; case fails if stale optimistic value persists | State audit; new StoreProvider test | P0 | Manual — executable |
| WS-STS-011 | Optimistic reaction | Toggle then API failure/SSE race | Existing multi-actor marks | Toggle; reject POST; interleave message.patch | Acceptance target: current user's mark reconciles to server without deleting others; error actionable | Current reducer has no rollback; repeated toggle parity and patch ordering are release gates | Dedicated route/provider test required | P0 | Manual — executable |
| WS-STS-012 | Optimistic branch | Switch branch then 409 | Server makes operator busy first | Activate revision | Acceptance target: UI returns to authoritative leaf and preserves stream/draft; error names why | Current optimistic branch may remain selected until refresh; document failure if observed | New StoreProvider test | P0 | Manual — executable |
| WS-STS-013 | Opening brief optimistic hide | First direction send fails | Opening card visible | Submit option, fail POST | Acceptance target: card and draft reconcile so user can retry once; server correctly retains card | Current reducer may hide locally until hydration; release-blocking regression case | Index send-failure + new provider E2E | P0 | Manual — executable |
| WS-STS-014 | Background frames | Message/group update for inactive run | User viewing another run | Emit frames | Correct owner/run state updates without replacing visible transcript; notification targets exact thread | Auto-speak/notify respects visible thread contract | Store notification tests | P1 | Automated — passing |
| WS-STS-015 | Restart durability | Server/app restart | Branches, pins, runs, reactions, cards, usage seeded | Stop cleanly and crash separately; reopen | Durable records restore exactly from JSON/SQLite; busy/provisioning/transient streams do not falsely persist | Legacy import occurs once; corrupted line/tail tolerated according to DB/event contract | `server/store.test.ts`, `server/message-db.test.ts`, thread-events tests | P0 | Automated — passing |
| WS-STS-016 | Search landing nonce | Two rapid results | Targets in different runs | Click A then B before A mounts | Only B consumes current focus nonce; A timer cannot clear/highlight B | Deleted owner/missing DOM after two seconds produces controlled error | `focus-message.ts`; direct tests required | P1 | Manual — executable |
| WS-STS-017 | Error recovery | Offline then online | Draft/selection active | Fail action, restore network, reconnect and retry | Error visible; authoritative snapshot repairs state; draft remains; only deliberate retry mutates | No automatic duplicate destructive action after reconnect | Provider/browser network trace | P0 | Manual — executable |

## Accessibility, touch, responsive layout, reduced motion, and content stress

Every case in this section is an acceptance requirement. A current source gap does not redefine the expected result; it makes the case fail until corrected.

| ID | Surface / route | Control / trigger | Preconditions | Action | Expected result | Negative / edge | Evidence | Priority | Execution |
|---|---|---|---|---|---|---|---|---|---|
| WS-AX-001 | Direct workstream at 390×844 | Maximum masthead state | Find, Stop, multi-run, usage, folder, model, call, Workbench and Trace all present | Capture and keyboard traverse | No horizontal clipping/overlap; all controls reachable with stable accessible names; content labels compact without disappearing | Current unwrapped shrink-0 bank is a known overflow risk; any hidden control fails | 390 screenshot + accessibility tree | P1 | Manual — executable |
| WS-AX-002 | Crew workstream at 390×844 | Maximum record actions | Long record, reply, pin, marks, timestamp | Touch and keyboard operate each | Controls wrap or occupy a separate row, remain visible on coarse pointer, and never clip behind `overflow-x-hidden` | Current nonwrapping/opacity-hidden row is a known P1 failure candidate | 390 touch trace | P1 | Manual — executable |
| WS-AX-003 | Direct records at 390×844 | User/operator action groups | Mixed records | Inspect without hover; activate all | Action controls are visible on mobile; record uses full width; composer does not cover last action/reaction chip | Long name/reply/revision count wraps without horizontal scroll | Screenshot + tap map | P1 | Manual — executable |
| WS-AX-004 | Composer at 390×844 | Text, attachments, reply, gate, held/error chips | Maximal state fixtures | Type, scroll, rotate virtual keyboard | Safe-area padding respected; editor/control rows remain visible; chips wrap; 9rem text cap scrolls; gate and reply do not cover send | Keyboard open/close and six-line draft do not jump transcript | Mobile viewport trace | P1 | Manual — executable |
| WS-AX-005 | Cards at 390×844 | Gate, credential, opening brief | Long labels/resources | Traverse | Definition rows/forms stack; resources scroll internally; decisions wrap in logical order; no offscreen destructive action | 400% zoom remains usable without two-dimensional page scroll | 390/400% screenshots | P1 | Manual — executable |
| WS-AX-006 | Run ledger at 390×844 | Open ledger | Long 80-char run names | Open, search, rename, confirm delete | Popover fits viewport, content truncates with accessible full label, focused control never unmounts to body | Fixed 320px panel plus viewport gutters must not overflow; touch outside closes | Screenshot/focus trace | P1 | Manual — executable |
| WS-AX-007 | Crew roster at 390×844 | Open modal | 12+ operators/long names | Scroll, toggle, save/cancel | Modal fits with edge padding; list scrolls; footer remains reachable; sigil trigger does not overflow masthead | Current fixed 340px modal/uncapped sigils fail if viewport clips | Screenshot + accessibility tree | P1 | Manual — executable |
| WS-AX-008 | 768×1024 mouse | Responsive desktop branch | Populated direct/crew | Hover/focus actions | `sm` editorial grids activate; hidden-on-hover controls appear on both hover and focus-within; no layout shift | Reaction popover fits six columns without overlap | Tablet screenshot/keyboard trace | P1 | Manual — executable |
| WS-AX-009 | 768×1024 coarse pointer | Touch tablet | `hover:none`, coarse pointer | Tap every record/run/artifact action | Controls needed to discover actions remain visible or have a visible menu; no hover-only dependency | Current width-keyed opacity rules are a known failure candidate | Real/emulated coarse-pointer trace | P1 | Manual — executable |
| WS-AX-010 | 1440×1000 | Wide shell with Trace/Workbench states | Open each side surface and both | Capture | Transcript stays capped/readable; container-query header compacts only when actual column requires; no excessive line length/overlap | Viewport width alone must not force full labels into a narrow column | Four wide screenshots | P2 | Manual — executable |
| WS-AX-011 | Keyboard focus | Workstream find | Trigger focused | Open, cycle, close by Escape and button | Input autofocuses; result controls have visible focus; close restores original Find trigger | Current unmount-only close fails if focus falls to body | Playwright focus assertions | P1 | Manual — executable |
| WS-AX-012 | Keyboard focus | Revision editor | Plain user record | Open, Tab, edit, cancel/commit | Textarea has visible ≥3:1 focus indicator despite global outline suppression; focus returns to invoking record/action | Current editor lacks explicit focus border/ring; invisible focus fails | Computed style + screenshot | P1 | Manual — executable |
| WS-AX-013 | Keyboard focus | Crew setup routing radios | Setup open | Tab through and select | Each radio has visible focus independent of checked color; group/labels announced | Current accent-only radio with global input outline suppression fails | Computed style + screen reader | P1 | Manual — executable |
| WS-AX-014 | Keyboard focus | Run ledger | Trigger focused | Open, Tab past final, Escape, select/new | Nonmodal intent is clear; focus never becomes lost; Escape returns trigger; close after selection moves to a stable workstream target | No hidden focused child after 500ms delayed close | Playwright focus log | P1 | Manual — executable |
| WS-AX-015 | Keyboard focus | Reaction picker | More trigger focused | Open and navigate all 22 marks | First mark focused; arrow-key grid or documented efficient keyboard pattern works; Escape restores trigger; focus cannot silently leave an open picker | Tab-only 22-stop grid is not accepted as production best behavior | Keyboard trace/a11y snapshot | P1 | Manual — executable |
| WS-AX-016 | Keyboard focus | Spoiler reveal/hide | Markdown spoiler | Reveal then hide | Focus transfers to the newly rendered Hide/Reveal control; hidden text exposure is announced | Replacement must not dump focus to body | Playwright focus assertions | P1 | Manual — executable |
| WS-AX-017 | Screen reader | Workstream logs/pagination | 140 records | Load earlier while VoiceOver/NVDA running | Current change announced concisely; 120 historical rows are not re-read as live new messages; active streaming still announced | `role=log aria-live=polite` prepend spam fails | Screen-reader transcript | P1 | Manual — executable |
| WS-AX-018 | Screen reader | Gate appears in composer | Focus in composer when request opens | Emit gate SSE | A concise “Gate waiting” announcement occurs once; focus is not stolen; user can navigate to decision group | Current non-live takeover must not be silent | Screen-reader transcript | P0 | Manual — executable |
| WS-AX-019 | Screen reader | Search loading/error | Inject success/empty/error | Type query | Exactly one useful status transition is announced; error is not duplicated by polite status plus alert | Stale request result is never announced | VoiceOver/NVDA log | P1 | Manual — executable |
| WS-AX-020 | Screen reader | Secret field | Credential card | Focus input and assurance | Name, consequence and “Stored locally; never written into the workstream” are all associated; value never appears in tree | Current description relation excluding local-only note fails | Accessibility tree | P0 | Manual — executable |
| WS-AX-021 | Touch targets | All compact controls | 390/coarse pointer | Overlay measured target boxes | Every actionable target is at least WCAG 2.2 24×24 CSS px without spacing exceptions; primary touch actions target 44×44 where layout permits | Find arrows/close, reply clear, Markdown copy, notice dismiss and crew release are explicit regression targets | Automated bounding-box report | P1 | Manual — executable |
| WS-AX-022 | Reduced motion | Entire domain | `prefers-reduced-motion: reduce` | Send, stream, open preview/picker, dictate, jump latest, animate sigils | No shimmer/spin/pulse/panel/pop/sigil/transform animation; scrolling is instant; state remains evident via text/icon | Current pop/panel/pulse/smooth-scroll gaps fail | Playwright reduced-motion trace | P1 | Manual — executable |
| WS-AX-023 | Forced colors | Entire domain | Windows high contrast | Traverse normal/error/gate/success states | Borders/focus/icons/text remain distinguishable; status is never color-only; disabled controls recognizable | Warm mineral fills may disappear without losing structure | Windows screenshot/a11y | P1 | Manual — executable |
| WS-AX-024 | Long/Unicode/RTL content | Records/cards/runs/names | 80-char run, 100-char crew, 12k brief, long unbroken token, emoji, Arabic/Hebrew | Render/search/reply/copy/export | Content wraps or scrolls in owned regions; inline code does not clip; offsets/snippets remain correct; UI chrome order stays logical | No page-level horizontal clipping; current `.chat-md` long-token gap fails | Width screenshots + export diff | P1 | Manual — executable |
| WS-AX-025 | Crew keyboard scrollback | PageUp/Home during streaming | Long busy crew transcript | Press PageUp/Home | Bottom-follow disarms and Latest appears; incoming deltas do not pull reader to bottom | Current parity gap with direct workstream fails | Browser scroll-position assertion | P1 | Manual — executable |
| WS-AX-026 | Expandable controls | Long entry, brief, workbench, roster, run ledger | Closed state | Open/close each | Trigger exposes correct `aria-expanded` and `aria-controls`; relationship remains stable; focus behavior defined | Show full/less and several crew toggles currently omit state relations | Accessibility snapshot | P1 | Manual — executable |
| WS-AX-027 | Record timestamps | Direct and crew | Keyboard only | Navigate record actions | Both use semantic `<time dateTime>` and make exact local timestamp available without pointer hover | Current crew hover-only plain timestamp fails | DOM/a11y assertion | P1 | Manual — executable |
| WS-AX-028 | Markdown remote image privacy | Operator Markdown contains remote image URL | Network interception enabled | Render | Product policy is explicit: block remote fetch by default or show consent-gated artifact; no silent tracking request from a transcript | Current ordinary Markdown image pass-through is a privacy release gate | Browser network assertion | P0 | Manual — executable |

## Expanded production-critical scenarios

### WS-E2E-001 — A direction is accepted at most once across response loss, retry, SSE, and restart

- **Priority:** P0
- **Execution:** Manual — executable; service layers automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg, browser development shell
- **Surface / route:** Direct composer; `POST /api/bots/:id/messages`; `GET /api/events`; SQLite messages
- **Controls / triggers:** Enter, Send direction, Retry this direction
- **Preconditions and fixtures:** `OP-RIVET`, `RUN-A`; proxy accepts first request but drops its HTTP response after persistence; SSE can be delayed independently.
- **Steps:**
  1. Type `Produce release evidence 7f29` and press Enter.
  2. Record generated `sendId`; allow server persistence/provider start, then drop HTTP response.
  3. Delay the matching message SSE until the red failed-send row appears.
  4. Activate Retry and assert the same text, thread, reply and `sendId` are used.
  5. Deliver the canonical retry response and original SSE in both possible orders in separate runs.
  6. Restart the app/server and inspect transcript and provider invocation counter.
- **Expected visible output:** One user direction, one operator outcome, no duplicate activity; failed row clears; draft stays empty only after accepted canonical state.
- **Expected persisted / network output:** One user message row, one provider turn, retries return the exact stored message ID; ordered SSE contains one canonical message projection.
- **Failure and recovery assertions:** Conflicting payload with same ID returns 409 and remains recoverable; an offline retry never erases the failed snapshot.
- **Accessibility assertions:** Failure alert and Retry have names/status; focus remains stable when row disappears.
- **Security and privacy assertions:** Request evidence is sanitized; no provider credential or unrelated draft enters the receipt.
- **Cleanup / reset:** Delete isolated profile and assert provider registry has no active session.
- **Automation mapping:** `server/send-idempotency.test.ts`; `src/state/store.test.ts`; `server/drafts.test.ts`.
- **Evidence to retain:** Trace, two-order request/SSE log, DB query, provider invocation count, restart screenshot.

### WS-E2E-002 — Busy steering, queued fallback, cancellation, and stop never cross a run boundary

- **Priority:** P0
- **Execution:** Manual — executable; service layers automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Composer; `/api/bots/:id/messages`; `/queue/:queueId`; `/interrupt`; run switch routes
- **Controls / triggers:** Add direction to active step, Hold this direction next, Remove held direction, Stop active step
- **Preconditions and fixtures:** Rivet busy with delayed steer adapter; Cairn busy without queueing; each has `RUN-A` and `RUN-B`.
- **Steps:**
  1. Send one direction to busy Rivet and one to busy Cairn.
  2. For Rivet, settle the turn before the delayed steer acknowledgement; for Cairn, capture queue ID.
  3. Attempt to switch each operator to `RUN-B` while still busy.
  4. Cancel Cairn’s queue; repeat delete; then stop both active runs.
  5. Settle adapters and inspect both run transcripts.
- **Expected visible output:** Rivet either records a valid same-run steer or reports a recoverable 409; Cairn shows then removes its held chip only after confirmed deletion; switch stays on `RUN-A`; Stop settles presence/gates.
- **Expected persisted / network output:** No record lands in `RUN-B`; cancelled queue never invokes provider; repeated delete 404 does not resurrect chip; exact-thread interrupt protects new work.
- **Failure and recovery assertions:** Deleted operator/run during delayed steer causes 404/409 and zero stray append; failed cancellation keeps visible chip.
- **Accessibility assertions:** Busy control names reflect steer/hold/stop state; status changes are polite and non-color-only.
- **Security and privacy assertions:** Queue prompt remains scoped to owner and cannot be cancelled by another operator ID.
- **Cleanup / reset:** Drain/cancel all queues, stop adapters, delete isolated runs.
- **Automation mapping:** `server/steer-e2e.test.ts`; `server/steer-queue.test.ts`; `src/state/store.test.ts`.
- **Evidence to retain:** Adapter timeline, request log, SSE log, transcript diff, focus trace.

### WS-E2E-003 — Revising and switching alternate paths preserves ancestry, replies, pins, search, and provider context

- **Priority:** P0
- **Execution:** Manual — executable; branching backend automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Revision editor, branch navigator, search; edit and active-branch endpoints
- **Controls / triggers:** Revise entry, Commit revision, Previous revision, Next revision, Respond to entry, Pin entry
- **Preconditions and fixtures:** `MSG-USER` replies to an earlier message; pin targets a descendant; provider idle.
- **Steps:**
  1. Revise `MSG-USER` with a unique phrase and commit.
  2. Wait for the new operator answer; verify the revision counter.
  3. Move to previous revision, search for unique phrases on both paths, and follow each result.
  4. Move forward again, inspect reply quote and pin banner, then restart.
- **Expected visible output:** Only active path records display; counter and focus identify chosen version; off-path search labels Alternate path and switches before focusing; reply snippet remains correct; stale/off-path pin does not crash.
- **Expected persisted / network output:** New user version is a sibling with inherited `parentId` and `replyToId`; active leaf persists; thread SSE confirms; provider replay contains only chosen path.
- **Failure and recovery assertions:** Busy/unavailable provider rejects before fork; rejected optimistic branch reconciles to authoritative leaf.
- **Accessibility assertions:** Editor focus visible; Escape preserves original; revision buttons expose bounds/disabled state.
- **Security and privacy assertions:** Reply excerpt is marked untrusted in provider context and strips attachment tags.
- **Cleanup / reset:** Restore original branch and remove test pin.
- **Automation mapping:** `server/branching.test.ts`; `server/replies.test.ts`; `server/message-db.test.ts`.
- **Evidence to retain:** Branch-tree DB dump, provider context, screenshots per version, search network log.

### WS-E2E-004 — A crew question is visible and answerable in the ordinary text workstream

- **Priority:** P0
- **Execution:** Manual — executable; currently a known release-blocking UI gap
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Crew workstream; `POST /api/threads/:crewThread/respond`
- **Controls / triggers:** Provider question choices, free-text answer, dismiss/deny where applicable
- **Preconditions and fixtures:** Forge Line member raises `request.opened` question with choices and no permission tool.
- **Steps:**
  1. Open the crew run before emitting the question.
  2. Emit question and wait for durable options message.
  3. Answer one fixture through a predefined choice; repeat isolated fixture with free text.
  4. Restart and verify settled state.
- **Expected visible output:** Question card identifies requesting member, prompt and choices; composer is blocked only as policy requires; chosen answer settles visibly and work continues.
- **Expected persisted / network output:** Thread respond receives `behavior=answer` and exact message once; card patches; no direct user message is sent to the member’s private thread.
- **Failure and recovery assertions:** If GroupView drops the no-tool options message, this scenario fails release; stale question closes unavailable rather than deadlocking.
- **Accessibility assertions:** New question announced once; choice/free-text controls labelled and focus-visible.
- **Security and privacy assertions:** Question text is untrusted provider content and cannot inject HTML/actions.
- **Cleanup / reset:** Close broker request and remove isolated crew profile.
- **Automation mapping:** Claude driver question tests and `GroupCallView` prove backend/voice only; new text-UI E2E required.
- **Evidence to retain:** Screenshot, accessibility tree, request/SSE log, DB card row.

### WS-E2E-005 — A persistent grant is narrower than the displayed Gate and never bypasses destructive safeguards

- **Priority:** P0
- **Execution:** Manual — executable; policy layer automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Pending Gate; bot PATCH/strict always-allow; thread respond; decision log
- **Controls / triggers:** Grant options, Always allow shell:project, later tool requests
- **Preconditions and fixtures:** `GATE-SHELL`; a benign same-key command, different program/key, destructive command and local Workbench command queued separately.
- **Steps:**
  1. Inspect full first Gate and select Always allow.
  2. Confirm grant PATCH settles before allow response.
  3. Issue exact benign match, different-key request, destructive request and local Workbench request.
  4. Inspect decisions and transcript.
- **Expected visible output:** First settles Allowed once; exact benign repeat can proceed within limits; other/destructive/local cases show Gates with exact consequences.
- **Expected persisted / network output:** One deduplicated allow key; decisions identify user/policy source; no second execution for duplicate decision click.
- **Failure and recovery assertions:** Grant-save failure reports error but current request does not strand; foreign/dismissed key refuses strict route.
- **Accessibility assertions:** Progressive disclosure announces exact key and consequence before persistent action.
- **Security and privacy assertions:** Remembered key is derived/trusted, not operator-supplied label; destructive/local safeguards override it.
- **Cleanup / reset:** Remove grant through operator policy settings and verify next match gates.
- **Automation mapping:** `server/auto-approve.test.ts`; `server/peer-approval.test.ts`; decision-log tests.
- **Evidence to retain:** Gate screenshots, ordered PATCH/respond log, decision rows, execution counter.

### WS-E2E-006 — Credential storage and continuation expose zero secret bytes outside the secure store

- **Priority:** P0
- **Execution:** Manual — executable; allowlist/redaction helpers automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg, browser development shell
- **Surface / route:** SecretRequestCard; desktop credential bridge; config fallback; secret-card lifecycle routes
- **Controls / triggers:** Password field, Store and continue, Decline gate, Retry resume, help link
- **Preconditions and fixtures:** `CRED-KEY`; disposable secret `qa-secret-42`; fault switches for secure-store cancel/fail, `/provided` fail and provider continuation fail.
- **Steps:**
  1. Capture DOM/accessibility/network/log/DB/SSE baselines and enter the secret.
  2. Complete a successful desktop secure-store flow; inspect all evidence and OS test store.
  3. Repeat isolated browser-fallback flow.
  4. Repeat save-success plus notify-failure, then select Resume run/Retry resume.
  5. Remove configured credential before retry and assert 409; test Decline in a clean fixture.
  6. Search and export the workstream, restart, and scan the complete isolated data directory for the literal value.
- **Expected visible output:** Value is masked and cleared immediately after storage; passed/declined/error/resume states are exact and actionable; run resumes once.
- **Expected persisted / network output:** Card routes contain only thread/card metadata; transcript stores target/label/outcome, not value; secure store alone contains value; one continuation.
- **Failure and recovery assertions:** Empty/double/wrong binding/dismiss-before-provided/not-configured/no-longer-configured cases fail closed without deadlock.
- **Accessibility assertions:** Local-only assurance is part of input description; error/status announced; loaders honor reduced motion.
- **Security and privacy assertions:** Literal scan over requests, responses, traces, screenshots OCR text, logs, SQLite, JSON, NDJSON, search and exports returns zero outside secure store fixture.
- **Cleanup / reset:** Delete disposable credential through the secure-store test bridge and destroy isolated profile.
- **Automation mapping:** `server/credential-request.test.ts`; `server/store.test.ts`; credential continuation index tests.
- **Evidence to retain:** Redacted trace, zero-hit scan output, DB/export samples, secure-store deletion receipt.

### WS-E2E-007 — Crew routing is deterministic under two clients, mentions, timeout, and interruption

- **Priority:** P0
- **Execution:** Manual — executable; service serialization/timeout partially automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Forge Line composer/routing; group message and interrupt routes
- **Controls / triggers:** Crew routing select, `@Rivet`, `@everyone`, Send, Stop active step
- **Preconditions and fixtures:** Two renderer clients; Rivet fast, Cairn delayed; default modes Lead/Everyone/Mentions tested in isolated runs.
- **Steps:**
  1. In each routing mode send an unmentioned direction and assert selected responders.
  2. Send explicit `@Rivet`, then `@everyone`, and assert explicit mentions override default.
  3. From two clients send distinct stable IDs while one operation is active.
  4. Interrupt during the delayed member and allow queued work to attempt settlement.
- **Expected visible output:** Immediate user records follow acceptance order; one named busy member at a time; explicit errors for archived/unavailable/no responder; no duplicate/missing record.
- **Expected persisted / network output:** Distinct sends serialize; retries coalesce; responder invocations match deterministic route exactly; interrupt cancels queued responders and credential continuations.
- **Failure and recovery assertions:** Timeout pauses for Gates, records one failure and hands off according to contract; run switch remains blocked until operation settles.
- **Accessibility assertions:** Routing accessible name/value, busy member status and error records are non-color-only.
- **Security and privacy assertions:** Mention cannot target hidden/nonmember operator or cross crew/thread ownership.
- **Cleanup / reset:** Stop all member adapters and delete isolated crew/runs.
- **Automation mapping:** `server/index.test.ts`; room timeout, member-turn, group-routing and send-idempotency tests.
- **Evidence to retain:** Two-client trace, ordered SSE/provider timeline, transcript DB, screenshots per routing mode.

### WS-E2E-008 — Mixed artifact intake preserves order, safety, recoverability, and preview containment

- **Priority:** P0
- **Execution:** Manual — executable; intake/storage helpers automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg, browser development shell
- **Surface / route:** Composer attachments; attachment POST/GET; preview dialog; send retry
- **Controls / triggers:** Add artifact, drag/drop, paste, Move into editor, Remove, Inspect, Save a copy, Send/Retry
- **Preconditions and fixtures:** `ARTIFACTS`; Rivet image-capable; one upload forced to fail; message response dropped after acceptance.
- **Steps:**
  1. Pick/drop PNG, PDF path, pathless text and an unsupported pathless file in one ordered batch.
  2. Paste long text and move it into the editor; remove only PDF; preview PNG and exercise focus trap/save/close.
  3. Send remaining artifacts, lose HTTP response, retry, and reload.
  4. Upload MIME-spoofed bytes as PNG and request them directly.
- **Expected visible output:** Accepted chips retain source order; one precise partial-failure notice; preview is same-origin and inert; retry yields one transcript record; missing file degrades safely.
- **Expected persisted / network output:** Image modes/issued basename correct; composed tags escape hostile paths; one canonical message; no arbitrary URL/path traversal.
- **Failure and recovery assertions:** Over-limit is 413; unsupported/empty 400; spoofed bytes cannot execute due to image decoding/`nosniff`; abandoned attachment cannot grant filesystem access.
- **Accessibility assertions:** Semantic list/listitems, named remove/preview controls, modal focus trap/restore and error announcements.
- **Security and privacy assertions:** Remote Markdown image request is blocked or consent-gated; local absolute path never becomes a renderer navigation URL.
- **Cleanup / reset:** Delete isolated attachment/profile directory after retaining hashes.
- **Automation mapping:** `server/attachments.test.ts`; composer/intake helper tests; drafts/idempotency tests.
- **Evidence to retain:** File hashes/modes, request log, composed prompt, focus trace, browser network assertion.

### WS-E2E-009 — Search lands on exact current, inactive-run, alternate-path, deleted, and paged records

- **Priority:** P1
- **Execution:** Manual — executable; search storage/API automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Global SearchResults, ChatFindBar, search API, task/branch switch and around pagination
- **Controls / triggers:** Query input, result button, Enter, Shift+Enter, next/previous, close
- **Preconditions and fixtures:** Unique phrase in current direct run, inactive direct run, inactive crew run, alternate branch, activity tool, record older than tail; a result owner deleted after response.
- **Steps:**
  1. Search globally for each fixture and activate result.
  2. Open scoped Find and cycle forward/backward through wrap boundary.
  3. Click A then B before A mounts; repeat same hit twice.
  4. Delete an owner after results arrive, then activate stale result.
- **Expected visible output:** Correct owner/run/branch selects before exact record centers/flashes; activity result is identified; old record loads around window; close restores Find trigger.
- **Expected persisted / network output:** Search is read-only; necessary run/branch switch routes occur once in order; focus nonce consumes only newest request.
- **Failure and recovery assertions:** Deleted/switch-failed/missing DOM produces controlled error and retains prior safe selection; stale query responses ignored.
- **Accessibility assertions:** Loading/count/empty/error announced once; marked substring offsets correct for Unicode; reduced motion avoids smooth animation.
- **Security and privacy assertions:** Search scope prevents cross-thread leak; deleted conversations and credential values are absent.
- **Cleanup / reset:** Restore original run/branch; close find; remove search fixtures.
- **Automation mapping:** `server/message-db.test.ts`; index search/pagination tests; direct focus-message tests required.
- **Evidence to retain:** Search bodies, route order, focus/scroll trace, screenshots of alternate-path and paged landing.

### WS-E2E-010 — Replay exhaustion and concurrent hydration converge on one exact state

- **Priority:** P0
- **Execution:** Manual — executable; transport pieces automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg, browser development shell
- **Surface / route:** `/api/events`, `/api/bots`, StoreProvider
- **Controls / triggers:** Network disconnect/reconnect, visibility/offline/online/focus lifecycle
- **Preconditions and fixtures:** Seed runs/cards/pins/queues; controllable server emits over 500 application frames including screen slots; REST snapshot can pause.
- **Steps:**
  1. Record cursor, disconnect, emit enough frames to evict it, reconnect.
  2. Assert `hello resumed:false`, pause replacement snapshot, emit message/bot/group/thread frames, then finish snapshot.
  3. Force a second non-resumable hello during hydration.
  4. Repeat with valid cursor and with hidden/offline lifecycle.
- **Expected visible output:** Saved workstreams remain available during recovery; final records/pins/runs/gates exactly match server; no stale stream/presence/ghost queue chip.
- **Expected persisted / network output:** Refused cursor is not committed before successful hydrate; buffered frames apply after snapshot; second gap causes one subsequent hydrate; resumable path avoids snapshot.
- **Failure and recovery assertions:** Failed optional peripheral does not block chat; failed chat snapshot retries; stale generation ignored; screen payload absence forces snapshot rather than broken replay.
- **Accessibility assertions:** Connection recovery does not steal focus or spam live regions.
- **Security and privacy assertions:** Rehydration projections strip provider cursors/credentials; native events remain redacted.
- **Cleanup / reset:** Close EventSource/client timers and destroy isolated stream profile.
- **Automation mapping:** `src/lib/live-events.test.ts`; `src/state/store.test.ts`; index SSE tests.
- **Evidence to retain:** Complete cursor/frame log, REST snapshots, final normalized state JSON, UI screenshots before/after.

### WS-E2E-011 — Run and crew deletion is confirmed, complete, and impossible while active

- **Priority:** P0
- **Execution:** Manual — executable; service rules partially automated and passing
- **Platforms:** macOS, Windows, Ubuntu/Xorg
- **Surface / route:** Run ledger and owning crew deletion UI; task/group DELETE routes; SQLite/event files/search
- **Controls / triggers:** Remove run, Keep run, confirmed crew removal
- **Preconditions and fixtures:** Direct/crew owners with two runs; target has messages, branches, pin, reply, reactions, events, provider session and search hit; active variant seeded separately.
- **Steps:**
  1. Open run confirmation and choose Keep; prove no request.
  2. Reopen, choose Remove on inactive run, then inspect every persistence/index surface.
  3. Attempt final-run, busy-run, active-cadence-run and working-crew deletion.
  4. Stop work and delete crew through explicit owning confirmation.
- **Expected visible output:** Consequence and exact title precede deletion; retained/current run switches safely; blocked cases explain Stop first; deleted owner disappears without blank shell.
- **Expected persisted / network output:** Target transcript/thread state/session/events/search hit gone; other run/owner untouched; group.deleted/task response reaches clients.
- **Failure and recovery assertions:** Inject disk/API failure and require no partial deletion or false UI disappearance; duplicate delete returns controlled missing state.
- **Accessibility assertions:** Confirmation announced with initial safe focus; destructive button follows safe cancel; focus moves to valid surviving destination.
- **Security and privacy assertions:** IDs cannot delete another owner’s thread; path resolution cannot remove files outside event/native target names.
- **Cleanup / reset:** Delete isolated remaining owner/profile after evidence.
- **Automation mapping:** Tasks, group-tasks, index and message DB tests.
- **Evidence to retain:** Confirmation screenshots, DB/file/search before-after manifests, SSE log.

## Known acceptance gaps that must not be mistaken for passing coverage

The following observations came from direct source review. They are explicit test outcomes, not deferred notes:

1. Crew text questions without a permission tool currently have no render branch; `WS-E2E-004` must fail until they are visible and answerable.
2. Reaction POST behavior, renderer rollback and multi-actor races have no dedicated route/browser proof.
3. `SecretRequestCard`, `PendingApproval`, `ChatView`, `GroupView`, `Composer`, `Reactions` and search interactions have no real DOM/browser suite.
4. Direct entry Copy currently reports success without awaiting clipboard success and lacks a live result; `WS-MSG-009` must reject false success.
5. Group-held direction removal discards unsent content immediately; `WS-CMP-014`/`015` require the product’s deliberate discard behavior to be explicit and recoverable where specified.
6. A failed first opening-brief send can leave renderer and server disagreement; `WS-STS-013` requires reconciliation.
7. Pending direct queue chips and the server steer queue are memory-only across restart; `WS-STS-008` is a product/release decision.
8. Optimistic crew patches, reactions and branch switches have no rollback; `WS-STS-010` through `012` require authoritative reconciliation.
9. Direct and crew interrupt actions in Store currently omit the optional exact `threadId`; stale-screen protection must be verified and preferably used.
10. Remote Markdown images can initiate network requests; `WS-AX-028` requires a privacy policy and browser assertion.
11. Crew record actions/timestamps, direct maximum masthead, 12+ member roster, run ledger/modal sizing and coarse-pointer visibility have specific clipping/discoverability risks.
12. Reduced-motion handling is incomplete for pop/panel/pulse/sigil/smooth scrolling; `WS-AX-022` is the acceptance gate.
13. Revision textarea and crew setup radios lack a proven visible focus replacement; Find close lacks proven focus restoration.
14. Several compact controls are below the 24×24 CSS-pixel target floor; `WS-AX-021` records exact bounding boxes.
15. Search focus/landing has no direct tests despite switching owners, runs, branches and transcript windows.

## Existing automated evidence and commands

Existing coverage is strong at helper and service boundaries but does not replace browser execution. A fresh run on 2026-08-30 passed all 38 files and 304 tests in the core command below. A separate fresh route run passed all 112 `server/index.test.ts` cases, and the broker Gate run passed 92 tests with one intentional platform/fixture skip. `server/store.test.ts` contains 54 collected cases (34 directly relevant), and `src/state/store.test.ts` contains 26 (20 directly relevant and included in the 304-test core run).

Run the core domain gate:

```bash
pnpm exec vitest run \
  server/attachments.test.ts server/auto-approve.test.ts server/branching.test.ts \
  server/composer-attachments.test.ts server/credential-request.test.ts server/drafts.test.ts \
  server/group-tasks.test.ts server/member-turn.test.ts server/message-db.test.ts \
  server/peer-approval.test.ts server/replies.test.ts server/room-turn-timeout.test.ts \
  server/send-idempotency.test.ts server/steer-e2e.test.ts server/steer-queue.test.ts \
  server/task-timeline.test.ts server/tasks.test.ts server/thread-events.test.ts \
  server/turn-context.test.ts server/turn-watchdog.test.ts \
  src/components/ApprovalCard.test.ts src/components/OptionCard.test.ts src/components/TaskPicker.test.ts \
  src/lib/activity-runs.test.ts src/lib/bottom-follow.test.ts src/lib/composer-attachments.test.ts \
  src/lib/composer-dock.test.ts src/lib/group-call.test.ts src/lib/group-routing.test.ts \
  src/lib/intake-files.test.ts src/lib/replies.test.ts src/lib/room-members.test.ts \
  src/lib/room-turn-timeout.test.ts src/lib/transcript-window.test.ts src/lib/turn-tail.test.ts \
  src/lib/unread.test.ts src/state/bot-patch-queue.test.ts src/state/store.test.ts \
  --reporter=verbose
```

Run the route boundary and broker Gates:

```bash
pnpm exec vitest run server/index.test.ts --reporter=verbose
pnpm exec vitest run \
  server/peer-approval.test.ts server/credential-request.test.ts \
  server/drivers/claude.test.ts server/comms.test.ts \
  --reporter=verbose
```

The release-level repository command remains:

```bash
pnpm test
```

Browser automation to implement from this specification must use stable accessible roles/names and network/DB fixtures, not CSS class selectors or timing-only sleeps. Each case ID becomes the test title prefix so failures map directly back to this contract.

## Completion accounting

- Compact cases: 269, mechanically counted from stable table-row IDs.
- Expanded end-to-end scenarios: 11.
- Total stable QA cases/scenarios in this document: 280.
- Route operations explicitly inventoried: 45.
- Required viewport widths: 390, 768, and 1440 pixels.
- Current automated browser journeys for this lane: 0; this document defines the production E2E backlog rather than falsely marking helper tests as button coverage.
- Intentional exclusions: calls/voice transport, Workbench internals, System/settings internals, Cadence management internals, Registry/Conduit, and mobile-native screens are owned by their respective QA documents. Their entry points inside a workstream are still covered here.
