# Agent notifications and proactivity QA

Helmryth treats **proactivity as an explicit trigger**, not as a hidden heartbeat. An operator may continue within an active run through Auto mode, may be started by a Cadence or Webhook, and may coordinate peers when its engine and profile allow that. This change does not add background polling that invents work or sends messages without one of those configured paths.

## Notification policy

The harness is the single owner of interruption policy. An operator with notifications disabled remains quiet. Otherwise it may emit:

- **Needs gate** or **has a question** when the run is blocked on the user.
- **Needs your hands** when a workstation run requires a takeover.
- **Finished** only when there is a non-empty result to summarize.
- **Cadence failed** when a scheduled or manual cadence run cannot complete.

Every notification carries both the operator ID and the exact run thread ID. A click must select that operator **and switch to that run**, including a cadence's detached run; opening whichever run happens to be active is a failure.

Desktop notifications are suppressed while the window already has focus. The iOS app can present live or replayed notifications while it is running and uses the same operator/run target when the notification is tapped. Waking a terminated iOS app still requires a future APNs relay; local network or VPN connectivity alone cannot provide closed-app delivery.

## Automated coverage

| Contract | Test |
|---|---|
| Per-operator off means quiet; empty completions stay quiet; summaries are bounded | `server/notify.test.ts` |
| Browser click returns the exact operator/run target | `src/lib/notify.test.ts` |
| Store navigation selects the operator and switches the run | `src/state/store.test.ts` |
| Cadence failure receipt and callback occur once | `server/routines.test.ts` |
| Real failed cadence emits one `cadence-failed` notification and no duplicate `done` | `server/notification-wiring.test.ts` |
| iOS target parsing and detached-run decision | `ios/Tests/CompanionCoreTests/DecodingTests.swift` |
| Paired-device route policy remains default-deny | `companion/test/routes.test.ts` |

## Manual release pass

Run these with two operators, notifications enabled on one and disabled on the
other:

1. Background the desktop window. Complete a normal run and confirm one
   result notification. Click it and verify the exact run opens.
2. Trigger a gate and a question. Confirm their copy, click targets, and that no duplicate completion notification appears before the run settles.
3. Run a cadence manually, then create a controlled failing run. Confirm the receipt shows the detached run and the failure generates exactly one alert.
4. Repeat the above with notifications disabled for that operator; the chat and run
   receipt should update without a system alert.
5. On iOS, tap a live/replayed notification for a non-active cadence run.
   Confirm the app switches the server-side active run before navigating.
6. Exercise Auto mode, a Cadence, and a Webhook independently. Verify each has
   a visible initiating user/configured trigger and that no unconfigured
   heartbeat starts work.

Live provider, OS-permission, backgrounding, and APNs behavior cannot be proven
by unit tests alone and remains part of the signed desktop/iPhone release pass.
