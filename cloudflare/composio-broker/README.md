# Helmryth Conduit

Conduit is Helmryth's connected-capability exchange. It keeps a shared
Composio project key out of desktop builds, gives every enrolled Node an
isolated Composio user and Session, proxies MCP traffic, and returns short-lived
Connect Links only when an operator explicitly starts authorization.

The desktop receives neither the Composio project key nor provider OAuth
tokens. Conduit tokens begin with `hry_`, are stored only as SHA-256 digests,
and identify a single Node. Authorization links are never persisted in
Workstream records.

## Public contract

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | readiness |
| `POST` | `/v1/nodes` | enroll a Conduit Node |
| `GET` | `/v1/self` | resolve the authenticated Node |
| `POST` | `/v1/mcp` | proxy Node-scoped MCP traffic |
| `GET` | `/v1/capabilities/catalog` | browse available capabilities |
| `GET` | `/v1/capabilities/active` | list active capabilities |
| `GET` | `/v1/capabilities?capabilities=…` | inspect selected capabilities |
| `POST` | `/v1/capabilities/:slug/authorize` | request a Connect Link |
| `DELETE` | `/v1/capabilities/:slug` | disconnect the selected account |
| `DELETE` | `/v1/capabilities/:slug/accounts/:id` | disconnect one owned account |

All `/v1/*` routes except Node enrollment require the Conduit bearer token.
`HELMRYTH_CONDUIT_ENROLLMENT_MODE=closed` stops new enrollment without
interrupting existing Nodes. Cloudflare rate-limit bindings separately bound
enrollment and Composio Session traffic.

## Local verification

From the repository root:

```sh
pnpm --filter @helmryth/conduit check
pnpm --filter @helmryth/conduit test
pnpm --filter @helmryth/conduit dry-run
pnpm conduit:preflight:test
```

Local type generation, tests, and dry runs use `wrangler.dev.jsonc`. That
configuration keeps local Node enrollment open and permits a Workers.dev-style
development target, but no production command consumes it.

## Production configuration

`wrangler.jsonc` is the production-only configuration. It is fail-closed by
default: `workers_dev` is false, enrollment is closed, and its route, origin,
D1 ID, and rate-limit namespace IDs are inert placeholders. The official
deployment command always runs the preflight before Wrangler and refuses to
deploy until every placeholder is replaced.

Before deploying:

1. Create a dedicated `helmryth-conduit` D1 database and replace the all-zero
   `CONDUIT_DB.database_id` in `wrangler.jsonc`.
2. Allocate non-zero rate-limit namespace IDs unique to the production
   Cloudflare account for both `NODE_ENROLLMENT_LIMITER` and
   `CONDUIT_SESSION_LIMITER`.
3. Replace `conduit.invalid` in both the custom-domain route and
   `HELMRYTH_CONDUIT_ORIGIN` with the exact HTTPS hostname owned for Conduit.
   The route hostname and origin must match. Do not use a Workers.dev hostname.
4. Leave `workers_dev` false and
   `HELMRYTH_CONDUIT_ENROLLMENT_MODE` set to `closed`. Enrollment may be opened
   only for a controlled enrollment window through a separately reviewed
   operational change; the production deploy preflight never permits it.
5. Store `COMPOSIO_API_KEY` with Wrangler's secret workflow; never place it in
   source, plain variables, logs, or a packaged desktop:

   ```sh
   pnpm exec wrangler secret put COMPOSIO_API_KEY \
     --config cloudflare/composio-broker/wrangler.jsonc
   ```

6. Confirm the provider-owned `COMPOSIO_API_BASE` and
   `COMPOSIO_TOOLKIT_BASE` values against current Composio documentation.
7. Run the migrations and guarded deployment:

   ```sh
   pnpm exec wrangler d1 migrations apply helmryth-conduit --remote \
     --config cloudflare/composio-broker/wrangler.jsonc
   pnpm conduit:preflight
   pnpm conduit:deploy
   ```

8. Configure the same exact HTTPS origin as `HELMRYTH_CONDUIT_URL` in the
   packaged desktop configuration.

`pnpm conduit:deploy` is the supported production lane. It rejects:

- `workers_dev` exposure;
- any enrollment mode other than `closed`;
- missing, all-zero, or placeholder D1/rate-limit IDs;
- a missing route or a route that does not match the configured origin;
- HTTP, Workers.dev, localhost, IP, or reserved-placeholder origins; and
- a missing `COMPOSIO_API_KEY` secret declaration.

A deployment can omit Conduit entirely and use Helmryth's local Composio path
with a user-provided project key.
