# Local control-plane request boundary

Helmryth's core listens only on IPv4 loopback and accepts one exact HTTP
authority: `127.0.0.1:$HELMRYTH_PORT`. `localhost`, IPv6, other `127/8`
addresses, and different ports are not aliases for this boundary. This exact
Host check prevents a public hostname from reaching the core through DNS
rebinding.

Browser requests may name only the renderer origin selected at launch:

- Packaged desktop: `http://127.0.0.1:$HELMRYTH_PORT`.
- Source development: `HELMRYTH_UI_ORIGIN`, defaulting to
  `http://127.0.0.1:${HELMRYTH_UI_PORT:-5199}`.

`HELMRYTH_UI_ORIGIN` is a canonical origin, not a URL prefix. Do not add a
trailing slash, credentials, path, query, or fragment. When
`HELMRYTH_DESKTOP_URL` is set, it must be the same exact origin. Vite rewrites
the proxied `Host` to the core authority while preserving the renderer's
`Origin` for this comparison.

All public `POST`, `PUT`, `PATCH`, and `DELETE` API requests use
`Content-Type: application/json`, including actions with an empty semantic
body such as cadence run/cancel/seen, webhook credential rotation, crew-import
undo, read acknowledgement, run switching, and deletion. Raw image upload at
`POST /api/attachments` is the only public non-JSON mutation. The separate
webhook-ingress listener retains its path-secret and payload-specific contract;
this policy does not change it.

Native and CLI clients may omit `Origin` because browser CSRF does not apply to
them. Local clients must still send `Content-Type: application/json` for every
public mutation. The authenticated companion gateway adds that declaration to
legacy bodyless native-device actions before forwarding them. Internal agent
routes remain protected by their per-boot bearer token and are not part of the
public renderer contract.

For a custom development UI port, export the same values in all three source
process terminals:

```sh
export HELMRYTH_UI_PORT=5299
export HELMRYTH_UI_ORIGIN=http://127.0.0.1:5299
pnpm dev:server
```

```sh
export HELMRYTH_UI_PORT=5299
export HELMRYTH_UI_ORIGIN=http://127.0.0.1:5299
pnpm dev
```

```sh
export HELMRYTH_UI_PORT=5299
export HELMRYTH_UI_ORIGIN=http://127.0.0.1:5299
pnpm dev:desktop
```
