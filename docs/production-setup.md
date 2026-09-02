# Helmryth production setup and secret ledger

This is the authoritative configuration contract for a production Helmryth deployment. It lists names and scopes only. Never place a real secret in source, a committed `.env` file, a screenshot, a workstream, diagnostics, or this document.

## Deployment profiles

Helmryth does not require every credential for every installation:

1. **Local desktop:** no Helmryth-managed secret is required when the selected engine CLI is already installed and authenticated on the machine.
2. **Desktop with optional capabilities:** add only the credentials for the enabled voice, image, capability, or Workbench features.
3. **Managed Helmryth services:** deploy Registry/Reach and, optionally, Conduit with their dedicated Cloudflare bindings and secrets.
4. **Official releases:** configure the protected release environment, signed managed-service endpoints, Windows and macOS signing/notarization material, the release-scoped GitHub token, and the iOS App Store upload lane.

## Desktop and headless runtime credentials

Packaged users should enter these through Helmryth System settings. Supported secrets are stored through Electron's operating-system-backed encrypted credential document. Environment variables are the fallback for source, CI, and headless runs.

| Secret | Required when | Runtime name | Scope and handling | Verification |
|---|---|---|---|---|
| xAI key | The Grok engine uses key-backed authentication | `XAI_API_KEY` | Injected only into the Grok driver | Run an isolated Grok probe; confirm diagnostics and `/api/config` expose only configured state |
| OpenAI-compatible key | OpenRouter, Groq, or another compatible endpoint is selected | `OPENAI_COMPAT_API_KEY` | Injected only into the OpenAI-compatible driver | List models and complete a bounded test run |
| Composio project key | Self-hosted Capabilities are enabled without managed Conduit | `COMPOSIO_API_KEY` | Used by the local harness or Conduit Worker; never exposed to the renderer | Fetch the catalog, authorize a sandbox account, then revoke it |
| Box key | Managed Remote Workbench is enabled | `BOX_TOKEN` | Injected only into the Box-backed driver; per-Workbench tokens use internal names | Provision, join, sleep, and remove a test Workbench |
| OpenCode key | A key-backed OpenCode provider is selected | `OPENCODE_API_KEY` | Injected only into the OpenCode driver | Refresh the engine catalog and run one isolated request |
| ElevenLabs key | ElevenLabs spoken replies or voice lines are enabled | `HELMRYTH_TTS_KEY` | Used only by the TTS service | Load voices and play a short non-sensitive sample |
| OpenAI image key | Generated operator sigils are enabled | `HELMRYTH_OPENAI_IMAGE_KEY` | Used only by the image-generation endpoint | Generate one disposable test sigil and verify the response contains no key material |
| AssemblyAI key | Recorded-method live transcription is enabled | `ASSEMBLYAI_API_KEY` | Permanent key remains in Electron; the renderer receives a short-lived streaming token | Mint a temporary token, record a short fixture, then clear the key |

Two custom engines support environment- or instance-scoped credentials that are not currently written by the standard System settings form:

| Secret | Required when | Runtime name | Scope and handling |
|---|---|---|---|
| Cursor credential | Cursor CLI is not already signed in | `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` | Set exactly one on the Cursor instance or launch environment; it is forwarded only to the Cursor driver |
| MiniMax key | A custom MiniMax API instance is configured and `mmx` has no authenticated local config | `MINIMAX_API_KEY` | Prefer the official `mmx` login/config; otherwise scope this key to the MiniMax instance |

The following settings are configuration, not secrets:

| Setting | Meaning |
|---|---|
| `OPENAI_COMPAT_URL` | Owned HTTPS API origin for the compatible provider |
| `OPENAI_COMPAT_MODEL` | Default model identifier |
| `OPENAI_COMPAT_PROVIDER` | Provider label used for catalog behavior |
| `MINIMAX_BASE_URL` | Optional owned MiniMax-compatible API root for a custom MiniMax instance |
| `DWEB_URL` | Optional loopback Dweb daemon origin when that local integration is enabled |
| VPS SSH alias | A validated entry in the user's SSH configuration; Helmryth never stores the SSH private key or password |

Provider CLIs such as Claude, Codex, Cursor, Kimi, Droid, Antigravity, Qwen, Hermes, and Pi may use their own authenticated CLI state. Do not export `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or unrelated provider keys globally to make a stock CLI work: Helmryth deliberately strips foreign provider credentials and re-injects only the credential owned by the selected driver. Use the provider's login flow or an explicitly configured custom instance instead.

## Registry and Reach production configuration

Registry owns email sign-in, Account/Node enrollment, Node credentials, and Reach lifecycle.

### Required secrets

| Secret | Requirement | Recommended creation and scope |
|---|---|---|
| `HELMRYTH_REGISTRY_AUTH_SECRET` | At least 32 characters; used to sign authentication state and derive privacy-safe OTP rate-limit keys | Generate independently for each environment with `openssl rand -base64 48`; store with `wrangler secret put`; rotate through an explicitly planned session invalidation |
| `CLOUDFLARE_API_TOKEN` | Reach tunnel and DNS management | Restrict to Tunnel write plus DNS read/write for the single owned zone; do not grant account-wide administration |

### Required non-secret variables and bindings

| Name | Production value |
|---|---|
| `HELMRYTH_REGISTRY_ORIGIN` | Exact owned HTTPS Registry origin |
| `HELMRYTH_EMAIL_FROM` | Verified sender address |
| `HELMRYTH_NODE_ORIGINS` | Exact semicolon/comma contract expected by the Worker for allowed desktop origins; never `*` |
| `CLOUDFLARE_ACCOUNT_ID` | Owned account identifier |
| `CLOUDFLARE_ZONE_ID` | The single Reach DNS zone identifier |
| `HELMRYTH_REACH_HOST_SUFFIX` | Owned hostname suffix for generated Reach addresses |
| `HELMRYTH_REACH_ORIGIN` | Exact loopback desktop Reach gateway, normally `http://127.0.0.1:<port>` |
| `REGISTRY_DB` | Production D1 database binding with migrations applied |
| `REGISTRY_EMAIL` | Cloudflare Email Sending binding restricted to the verified sender |

Before enabling hosted onboarding, `GET <HELMRYTH_REGISTRY_ORIGIN>/healthz` must return the exact Registry identity over HTTPS.

## Conduit production configuration

Conduit is optional. It keeps a shared Composio project credential out of the desktop and issues scoped Helmryth Node credentials.

| Item | Type | Requirement |
|---|---|---|
| `COMPOSIO_API_KEY` | Secret | A dedicated production project key with Sessions read/write, Toolkits read, and Connected Accounts read/write |
| `CONDUIT_DB` | D1 binding | Dedicated production database with migrations applied |
| `NODE_ENROLLMENT_LIMITER` | Rate-limit binding | Namespace unique to the production account |
| `CONDUIT_SESSION_LIMITER` | Rate-limit binding | Separate namespace unique to the production account |
| `COMPOSIO_API_BASE` | Non-secret variable | Current provider API origin, verified before deployment |
| `COMPOSIO_TOOLKIT_BASE` | Non-secret variable | Current provider toolkit API origin |
| `HELMRYTH_CONDUIT_ENROLLMENT_MODE` | Non-secret variable | Explicit reviewed mode; do not inherit a development default silently |
| `HELMRYTH_CONDUIT_ORIGIN` | Non-secret variable | Exact owned HTTPS Conduit origin; it must match the production custom-domain route |
| `HELMRYTH_CONDUIT_URL` | Desktop runtime configuration | Exact deployed HTTPS Conduit origin |

`HELMRYTH_CONDUIT_TOKEN` is not an operator-provided secret. It is issued by Conduit, stored by the desktop credential service, and injected only into the local harness.

## Official release configuration

Configure these under GitHub **Settings → Environments → `release-production`** for the source repository. Protect that environment with reviewer approval before any publish-capable job.

### Repository variable

| Variable | Requirement |
|---|---|
| `HELMRYTH_RELEASE_REPO` | Exact owned `owner/repo` destination for public artifacts and update feeds |
| `HELMRYTH_RELEASE_REGISTRY_ORIGIN` | Exact owned HTTPS Registry origin baked into official packages |
| `HELMRYTH_RELEASE_CONDUIT_ORIGIN` | Exact owned HTTPS Conduit origin baked into official packages |
| `HELMRYTH_WINDOWS_PUBLISHER_NAME` | Exact Authenticode subject string, or a JSON array of exact accepted subjects |
| `HELMRYTH_WINDOWS_TIMESTAMP_SERVER` | Exact HTTP or HTTPS timestamp URL used for Windows signing |
| `HELMRYTH_IOS_DEVELOPMENT_TEAM` | Exact Apple Developer team ID used for archive/export |
| `HELMRYTH_IOS_BUNDLE_ID` | Must match `com.helmryth.app` unless `ios/project.yml` is intentionally changed first |
| `HELMRYTH_IOS_WIDGET_BUNDLE_ID` | Must match `com.helmryth.app.widgets` unless `ios/project.yml` is intentionally changed first |

### Repository secrets

| Secret | Purpose |
|---|---|
| `HELMRYTH_RELEASES_PAT` | Fine-grained token scoped only to the release repository with Contents read/write |
| `HELMRYTH_RELEASE_TAG_PUBLIC_KEYS_ASC` | ASCII-armored trusted public keys for signed release tags outside protected `main` |
| `HELMRYTH_MAC_CERT_P12_BASE64` | Base64 Developer ID Application certificate export |
| `HELMRYTH_MAC_CERT_PASSWORD` | Strong password for that certificate export |
| `HELMRYTH_APPLE_API_KEY_P8_BASE64` | Base64 App Store Connect API private key used for notarization |
| `HELMRYTH_APPLE_API_KEY_ID` | App Store Connect key ID |
| `HELMRYTH_APPLE_API_ISSUER_ID` | App Store Connect issuer ID |
| `HELMRYTH_WINDOWS_CERT_PFX_BASE64` | Base64 Authenticode `.pfx` certificate for official Windows releases |
| `HELMRYTH_WINDOWS_CERT_PASSWORD` | Password for that `.pfx` export |
| `HELMRYTH_IOS_ASC_KEY_ID` | App Store Connect API key ID for the iOS upload lane |
| `HELMRYTH_IOS_ASC_ISSUER_ID` | App Store Connect issuer ID for the iOS upload lane |
| `HELMRYTH_IOS_ASC_KEY_P8_BASE64` | Base64 App Store Connect API private key for the iOS upload lane |
| `HELMRYTH_IOS_SIGNING_CERT_P12_BASE64` | Base64 Apple Distribution certificate export for iOS archives |
| `HELMRYTH_IOS_SIGNING_CERT_PASSWORD` | Password for that iOS certificate export |
| `HELMRYTH_IOS_PROFILE_APP_BASE64` | Base64 App Store provisioning profile for `com.helmryth.app` |
| `HELMRYTH_IOS_PROFILE_WIDGET_BASE64` | Base64 App Store provisioning profile for `com.helmryth.app.widgets` |

Official desktop packages now carry the signed non-secret managed-service contract at `process.resourcesPath/helmryth-service-config.json`. The current release overlay writes:

- `schemaVersion`
- `registryOrigin`
- `conduitOrigin`

Rotate release tokens and certificates before expiry, keep recovery owners documented outside the repository, require branch/environment approval before publication, and treat any release-signing key exposure as a supply-chain incident.

## Internal and ephemeral values: do not configure manually

These names are generated or tightly scoped internal transport values. Setting them as global production secrets can bypass ownership or route selection:

- `HELMRYTH_TOKEN`, `HELMRYTH_COMMS_TOKEN`, and `HELMRYTH_CONTROL_TOKEN`
- `HELMRYTH_BROWSER_TOKEN`
- `HELMRYTH_BOX_TOKEN` and `HELMRYTH_BOX_ID`
- `HELMRYTH_CONDUIT_TOKEN`
- pairing credentials, device tokens, connector tokens, Reach connector tokens, and signed viewer URLs

Let the owning service mint, rotate, persist, and revoke these values.

The following endpoint/test overrides are not production credentials and should remain unset in a normal release: `ALLOW_INSECURE_HTTP`, `HELMRYTH_BOX_API`, `HELMRYTH_COMPOSIO_API`, `HELMRYTH_COMPOSIO_TOOLKITS_API`, `HELMRYTH_ELEVENLABS_API`, `HELMRYTH_E2E_BOX_TOKEN`, and every `FAKE_*` or `HELMRYTH_SMOKE_*` name. They exist for local fixtures, controlled self-hosting, or CI and can weaken routing guarantees if exported globally.

## Production setup order

1. Create owned domains, Cloudflare account/zone resources, D1 databases, rate-limit namespaces, and the verified email sender.
2. Replace every all-zero or `.test` value in an uncommitted deployment-specific Wrangler configuration.
3. Apply Registry and Conduit migrations.
4. Store Worker secrets with `wrangler secret put`; never place them under `vars`.
5. Deploy and verify Registry/Reach, then Conduit if used.
6. Configure the desktop's exact managed-service origins and exercise Account → Node → Reach and Node → Conduit enrollment using sandbox identities.
7. Configure optional feature credentials through the packaged app and verify each one independently.
8. Configure release secrets and the release-repository variable.
9. Run the complete local gate, provisioned end-to-end matrix, signed package checks, update-feed verification, and rollback drill before publication.

The checked-in production Worker files are intentionally non-deployable skeletons. After filling an uncommitted deployment copy, prove each guarded lane before any live mutation:

```sh
pnpm registry:preflight
pnpm conduit:preflight
pnpm release:config:check
```

Each command must fail on placeholder `.test`, `.invalid`, wildcard, all-zero, Workers.dev, route-mismatch, or missing-secret configuration and pass only with exact owned production values.

## Rotation and incident rules

- Never rotate several credential classes in one unobserved change.
- Revoke the old value only after the new value is verified in a bounded test.
- Treat Registry auth-secret rotation as a session-invalidating event.
- Treat Cloudflare token exposure as Tunnel and DNS authority exposure.
- Treat release-token or signing-key exposure as a supply-chain incident; stop publication and rotate immediately.
- Export diagnostics only after reviewing the redacted file. No command transcript retained for evidence may contain a secret value.
