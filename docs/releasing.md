# Releasing

One workflow builds everything: **Actions → Release → Run workflow**. It builds macOS (arm64 + x64, signed, notarized, stapled), Windows (Authenticode-signed), and Ubuntu from a single pinned commit, verifies every artifact the way a user would receive it, assembles a complete draft on the repository named by `HELMRYTH_RELEASE_REPO`, and — if you ticked **publish** — flips it live. Leave publish unticked to review the draft notes first, then publish from the GitHub UI.

The workflow refuses to overwrite an already-published version, so the only prerequisite per release is that `package.json`'s version is bumped on the ref you run it against.

Every secret-bearing or publication job now runs through the protected GitHub Environment `release-production`. Store release variables and secrets there, require reviewer approval on that environment, and treat repository-level release settings as unsupported drift.

## Why the gates exist

Each verification step in `release.yml` blocks a failure reproduced during release hardening: stale output breaking a code signature, a bare import killing a packaged server while shallow checks stay green, helper paths resolving outside the app, stapling invalidating published hashes, and a finished release remaining an unpublished draft. Don't remove a gate without preserving equivalent proof.

## One-time setup: protected environment variables and secrets

Set these in **Helmryth → Settings → Environments → `release-production`**.

### 1. `HELMRYTH_RELEASE_REPO`

An environment variable in `owner/repo` form that points at the release target.
The workflow refuses to start without it and never falls back to any inherited repository.

### 2. `HELMRYTH_RELEASE_REGISTRY_ORIGIN` + `HELMRYTH_RELEASE_CONDUIT_ORIGIN`

Exact owner-controlled HTTPS endpoints baked into official packages as the signed non-secret resource `process.resourcesPath/helmryth-service-config.json`.

- `HELMRYTH_RELEASE_REGISTRY_ORIGIN` must be a bare HTTPS origin such as `https://registry.helmryth.example`
- `HELMRYTH_RELEASE_CONDUIT_ORIGIN` must be a bare HTTPS origin such as `https://conduit.helmryth.example`

Local development stays environment-driven; release packages fail closed without these values.

### 3. `HELMRYTH_RELEASE_TAG_PUBLIC_KEYS_ASC`

ASCII-armored trusted public keys for maintainers allowed to sign a release tag that is not reachable from protected `main`. The release lane accepts:

- any exact commit/branch/tag ref whose resolved commit is reachable from `origin/main`
- an approved semver-like tag such as `v1.2.3` or `v1.2.3-rc.1` whose signature verifies against `HELMRYTH_RELEASE_TAG_PUBLIC_KEYS_ASC`

Any other free-form ref is rejected before packaging.

### 4. `HELMRYTH_MAC_CERT_P12_BASE64` + `HELMRYTH_MAC_CERT_PASSWORD`

The Developer ID Application certificate, exported from the Mac that
currently signs releases:

```sh
# Keychain Access → My Certificates → your Helmryth Developer ID Application
# certificate → right-click → Export… → .p12 with a strong password, then:
base64 -i DeveloperID.p12 | pbcopy   # → HELMRYTH_MAC_CERT_P12_BASE64
# the export password             → HELMRYTH_MAC_CERT_PASSWORD
```

### 5. `HELMRYTH_APPLE_API_KEY_P8_BASE64` + `HELMRYTH_APPLE_API_KEY_ID` + `HELMRYTH_APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → HELMRYTH_APPLE_API_KEY_P8_BASE64
```

### 6. `HELMRYTH_WINDOWS_CERT_PFX_BASE64` + `HELMRYTH_WINDOWS_CERT_PASSWORD`

The Authenticode signing certificate exported as `.pfx` and base64-encoded for CI:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("HelmrythRelease.pfx"))
```

Use a dedicated release certificate. Official Windows releases now fail closed if this certificate or password is missing.

### 7. `HELMRYTH_WINDOWS_PUBLISHER_NAME` + `HELMRYTH_WINDOWS_TIMESTAMP_SERVER`

Protected environment variables for the exact signer identity and timestamp endpoint used in the signed release overlay:

- `HELMRYTH_WINDOWS_PUBLISHER_NAME`: exact certificate subject, or a JSON array of accepted exact subjects
- `HELMRYTH_WINDOWS_TIMESTAMP_SERVER`: exact HTTP or HTTPS timestamp URL accepted by `signtool`

The workflow verifies both the signed EXE subjects and the `app-update.yml` publisher identity against these values.

### 8. `HELMRYTH_RELEASES_PAT`

A fine-grained personal access token that lets the workflow write to the
separate releases repo: **GitHub → Settings → Developer settings →
Fine-grained tokens** → repository access: only the repo named by
`HELMRYTH_RELEASE_REPO` →
permissions: **Contents: Read and write**. Set a long expiry and a calendar
reminder.

### 9. iOS release lane secrets and variables

`release-ios.yml` archives and uploads only after these protected values exist:

- variables: `HELMRYTH_IOS_DEVELOPMENT_TEAM`, `HELMRYTH_IOS_BUNDLE_ID`, `HELMRYTH_IOS_WIDGET_BUNDLE_ID`
- secrets: `HELMRYTH_IOS_ASC_KEY_ID`, `HELMRYTH_IOS_ASC_ISSUER_ID`, `HELMRYTH_IOS_ASC_KEY_P8_BASE64`, `HELMRYTH_IOS_SIGNING_CERT_P12_BASE64`, `HELMRYTH_IOS_SIGNING_CERT_PASSWORD`, `HELMRYTH_IOS_PROFILE_APP_BASE64`, `HELMRYTH_IOS_PROFILE_WIDGET_BASE64`

The lane validates that the bundle IDs still match `ios/project.yml` before it creates an archive, so account drift is caught early.

### Local fallback

The hand-cut path still works when Actions is down or a release needs surgery: export `HELMRYTH_RELEASE_REPO=owner/repo`, `HELMRYTH_RELEASE_REGISTRY_ORIGIN=https://registry.helmryth.example`, and `HELMRYTH_RELEASE_CONDUIT_ORIGIN=https://conduit.helmryth.example`; for Windows also export the signing certificate/password, publisher identity, and timestamp server. Run `pnpm release:config:check`, then run `pnpm package:release:mac`, `pnpm package:release:win`, and `pnpm package:release:linux` as needed. Gate each artifact with `codesign --verify --deep --strict`, `Get-AuthenticodeSignature`, notarization/upload tooling, `node scripts/verify-update-target.mjs`, `node scripts/verify-managed-service-config.mjs`, and feed/hash verification. Temporary release config stays private and is removed after the run.
