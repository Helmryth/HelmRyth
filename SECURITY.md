# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub's private vulnerability reporting for this repository if it is enabled.
- If private vulnerability reporting is not enabled yet, stop short of public disclosure and require
  the Helmryth owners to publish a Helmryth-controlled private security contact before public
  release.

This repository intentionally does not direct reports to a previous maintainer's personal email
address, and it should never ask researchers to disclose a vulnerability in public issues, pull
requests, or discussions.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only** and has no authentication by design — it trusts the
  local user. Anything that makes it reachable from off-machine, or lets one local *unprivileged
  other user* drive it, is a vulnerability.
- API keys live in `~/.helmryth/config.json` and are write-only through the API (`configured`
  booleans out, never values). Any path that echoes a stored secret back — API response, SSE event,
  log line, argv visible in `ps` — is a vulnerability.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions. Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.
