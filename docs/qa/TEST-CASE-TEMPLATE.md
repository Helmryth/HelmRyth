# Helmryth QA case contract

Every test in this QA corpus uses the fields below. A domain document may use a table for compact control coverage and expanded cases for complex flows, but it may not omit a required field or replace concrete cases with “repeat similarly.”

## Status and priority

- **Priority:** `P0` data loss, security bypass, release corruption, or unusable core flow; `P1` broken supported behavior, inaccessible critical control, or major regression; `P2` polish, resilience, or uncommon edge.
- **Execution:** `Automated — passing`, `Manual — executable`, `Blocked — external prerequisite`, or `Not applicable`.
- **Platforms:** macOS, Windows, Ubuntu/Xorg, browser development shell, iOS, Android, Registry Worker, or Conduit Worker as applicable.

## Compact control case

| Field | Required content |
|---|---|
| ID | Stable domain-prefixed identifier, for example `WS-BTN-014` |
| Surface / route | Exact screen, API route, IPC channel, deep link, or workflow |
| Control / trigger | Visible label, accessible name, HTTP method, event, shortcut, or system trigger |
| Preconditions | Required state, permissions, fixtures, credentials, platform, and feature flags |
| Action | Exact click, key, gesture, request, payload, or lifecycle event |
| Expected result | Visible state, response/status, persisted mutation, emitted event, focus destination, and absence of unintended effects |
| Negative / edge | Disabled state, malformed input, duplicate action, race, failure, recovery, and cleanup expectations |
| Evidence | Existing automated test path/name, manual evidence to capture, or external blocker |
| Priority | P0, P1, or P2 |

## Expanded scenario

### `<ID>` — `<behavioral outcome>`

- **Priority:**
- **Execution:**
- **Platforms:**
- **Surface / route:**
- **Controls / triggers:**
- **Preconditions and fixtures:**
- **Steps:**
  1. Use exact, reproducible actions.
- **Expected visible output:**
- **Expected persisted / network output:**
- **Failure and recovery assertions:**
- **Accessibility assertions:**
- **Security and privacy assertions:**
- **Cleanup / reset:**
- **Automation mapping:**
- **Evidence to retain:** screenshot, trace, response body, log excerpt, package hash, or test report.

## Required coverage dimensions

Every domain document must explicitly cover:

1. First use, populated state, empty state, loading, success, partial success, stale state, recoverable error, terminal error, and retry.
2. Mouse, keyboard, focus order, Escape/cancel, screen-reader name/state, reduced motion, and 390px/768px/1440px layouts for rendered controls.
3. Valid input boundaries, empty/null/wrong-type/oversized input, duplicate submission, concurrent action, delayed response, cancellation, restart, and reconnect where meaningful.
4. Authorization, secret redaction, local-only boundaries, destructive confirmation, audit trail, and fail-closed behavior for consequential actions.
5. Exact automation coverage or a manual/external reason. “Covered elsewhere” must link to the owning case ID.

