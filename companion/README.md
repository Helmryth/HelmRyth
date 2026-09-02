# Helmryth companion

The companion is the phone-facing sidecar for Helmryth.

Helmryth keeps the harness bound to loopback. The companion sits in front of it and exposes only the mobile-facing verbs the phone needs. Pairing, device tokens, network exposure, and response scrubbing stay in the sidecar.

```text
phone ──LAN/tailnet──▶ companion :8810 ──loopback──▶ harness :8799
                     ▲                              ▲
                     │ token, allowlist,            │ loopback-only
                     │ Origin refused               │ trust boundary
```

## Responsibilities

| Capability | What it does |
|---|---|
| Pairing | Creates a short-lived QR code and six-digit fallback, then stores only a digest of the device token. |
| Authorization | Requires a device token for every request. Full computer access stays a separate capability. |
| Allowlist | Exposes only the narrow read and gate routes the mobile client actually needs. |
| Scrubbing | Removes internal session cursors before the phone sees a response. |
| Discovery | Uses Bonjour so the phone can find the workbench by name. |

## Transport

- Over a tailnet, traffic is protected by the network overlay.
- Over a LAN, traffic is cleartext on that network.
- Do not treat LAN transport as private unless you trust the network.

## Running it

With the harness already running:

```bash
pnpm companion
```

The sidecar prints the companion address, the pairing page, and the workbench name that the phone should display.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `HELMRYTH_PORT` | `8799` | Harness port |
| `HELMRYTH_WEBHOOK_PORT` | `HELMRYTH_PORT` + 1 | Harness webhook receiver |
| `HELMRYTH_COMPANION_PORT` | `8810` | Phone-facing companion port |
| `HELMRYTH_CONTROL_PORT` | `8811` | Loopback pairing page |
| `HELMRYTH_COMPANION_DIR` | `~/.helmryth-companion` | Paired device state |
| `HELMRYTH_COMPANION_NAME` | Harness profile name | Bonjour name shown on the phone |

## Layout

```text
src/index.ts    entrypoint
src/proxy.ts    request forwarding and /api/pair
src/routes.ts   device allowlist
src/wire.ts     scrubbing and SSE transforms
src/control.ts  loopback pairing page
src/devices.ts  pairing codes and device tokens
src/listener.ts LAN and tailnet addresses
src/mdns.ts     Bonjour responder
src/state.ts    paired device storage
test/           integration tests
```
