# Helmryth Registry

Registry is Helmryth's deliberately narrow cloud identity service. It owns
accounts, Node enrollment, revocable Node credentials, and one optional Reach
per Node. Operator definitions, Crews, Workstreams, Missions, prompts,
artifacts, tool output, and desktop SQLite data remain on the user's device.

## Security boundary

- Better Auth 1.7.1 provides email OTP, signed account bearer sessions, hashed
  OTP storage, and D1-backed rate limiting.
- Account sessions and Node credentials are separate credential classes. A
  Node credential always begins with `hry_node_`; Registry never accepts it as
  an account session and never accepts an account session on a Node route.
- Raw Node credentials contain a random lookup ID and 32 random bytes. Only a
  SHA-256 digest is stored. Credentials expire after 90 days and can be rotated
  or revoked independently.
- CORS uses an exact HTTPS allow-list. Wildcards are rejected. Request bodies
  are bounded, public errors are canonical and redacted, and every response is
  `no-store`.
- Email delivery logs never include recipient addresses, OTP values, secrets,
  or provider response bodies.
- `HELMRYTH_REGISTRY_ORIGIN` is the canonical authentication origin used by
  Better Auth. This service does not mint a separate cross-service JWT or
  accept a caller-selected issuer or audience.

## Reach boundary

A Reach is a remotely managed Cloudflare Tunnel dedicated to one Node. Its
opaque hostname forwards only to the configured loopback origin in
`HELMRYTH_REACH_ORIGIN`; Registry rejects any non-loopback value. A mandatory
`http_status:404` catch-all follows that ingress rule. A proxied CNAME points to
`<tunnel-id>.cfargotunnel.com`.

Registry serializes Reach mutation with D1 generation leases, validates every
Cloudflare response before persisting an identifier, and recovers interrupted
work by a stable opaque tunnel name. It never stores connector tokens. Cleanup
deletes DNS before the tunnel, retains resource IDs after partial failure, and
uses bounded exponential backoff from five minutes to 24 hours. Destructive
cleanup revalidates provider-side names and targets, so a repurposed resource
is left for an operator instead of being guessed at.

The public service behind a Reach must still enforce Helmryth pairing and
application authentication. The tunnel is transport, not authorization.

## Public contract

| Method | Path | Authentication |
| --- | --- | --- |
| `GET` | `/healthz` | none |
| any | `/api/auth/*` | Better Auth |
| `GET` | `/v1/account` | account bearer |
| `GET`, `POST` | `/v1/nodes` | account bearer |
| `POST` | `/v1/nodes/:id/credentials/rotate` | owning account bearer |
| `DELETE` | `/v1/nodes/:id` | owning account bearer |
| `GET` | `/v1/nodes/self` | Node credential |
| `GET`, `POST`, `DELETE` | `/v1/nodes/self/reach` | Node credential |

Node enrollment requires a stable `clientInstanceId`, a display `name`, and a
`platform` of `darwin`, `windows`, or `linux`; `appVersion` is optional. An
account may own at most 100 active Nodes. Enrollment is limited to 100 attempts
per account per hour, while credential rotation has a one-minute cooldown.

`GET /v1/nodes/self/reach` returns `{ "reach": null }` until allocation or
after deletion. `POST` idempotently provisions or reconciles the Reach and
returns `{ reach, connectorToken }`; the caller must immediately place the raw
connector token in the operating system's secure credential store. `DELETE`
returns `204` when cleanup is complete or already complete. Concurrent changes
return `409 reach_busy`, while a retryable provider cleanup failure returns
`503 reach_cleanup_pending`.

Reach hostnames use
`r-<32-lowercase-hex>.<HELMRYTH_REACH_HOST_SUFFIX>`. The suffix must belong to
the configured Cloudflare zone and be covered by its edge certificate.

## Storage

The pinned D1 migrations create:

- Better Auth 1.7.1 tables;
- Node ownership and credential metadata;
- recipient and account action rate limits;
- Reach lifecycle, lease, and cleanup state; and
- Node-scoped Reach mutation limits.

Reach rows deliberately do not cascade away with a hard Node deletion because
their provider resource IDs are required for safe cleanup.

## Local verification

From the repository root:

```sh
pnpm --filter @helmryth/registry check
pnpm --filter @helmryth/registry test
pnpm --filter @helmryth/registry dry-run
```

For manual local development, copy `.dev.vars.example` to `.dev.vars`, replace
the example secrets, then run:

```sh
pnpm --filter @helmryth/registry exec wrangler d1 migrations apply REGISTRY_DB --local --config wrangler.dev.jsonc
pnpm --filter @helmryth/registry exec wrangler dev --config wrangler.dev.jsonc
```

Never commit `.dev.vars`.

## Production configuration

`wrangler.dev.jsonc` is the local-safe configuration. The checked-in
`wrangler.jsonc` is a production skeleton guarded by a deploy preflight and
intentionally contains reserved hostnames plus all-zero Cloudflare resource
identifiers so it cannot be deployed unchanged. Before deploying:

1. Create a dedicated Cloudflare account deployment or select an owned
   account, then set its account and zone IDs.
2. Create new `helmryth-registry` D1 and Email Sending resources, update the D1
   identifier and sender binding, review the migrations, and apply them.
3. Set one owned HTTPS hostname as `HELMRYTH_REGISTRY_ORIGIN`; configure the
   exact same hostname as the Worker `custom_domain` route in a private
   deployment config.
4. Generate `HELMRYTH_REGISTRY_AUTH_SECRET` and a least-privilege
   `CLOUDFLARE_API_TOKEN` through Wrangler's secret workflow. The Cloudflare
   token needs Tunnel write plus DNS read/write only for the selected zone.
5. Set `HELMRYTH_EMAIL_FROM`, `HELMRYTH_NODE_ORIGINS`,
   `HELMRYTH_REACH_HOST_SUFFIX`, and the exact loopback
   `HELMRYTH_REACH_ORIGIN` used by the desktop Reach gateway.
6. Verify `GET <HELMRYTH_REGISTRY_ORIGIN>/healthz` returns exactly
   `{ "ok": true, "service": "helmryth-registry" }` over HTTPS before enabling
   hosted onboarding in a desktop build.

Use the guarded production lane:

```sh
pnpm --filter @helmryth/registry preflight
pnpm --filter @helmryth/registry run deploy:production
```

No inherited account ID, zone ID, database ID, sender domain, custom hostname,
or public endpoint is shipped by this directory.
