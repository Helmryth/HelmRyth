# Helmryth Mobile privacy

Helmryth Mobile is a companion for a Helmryth service chosen and operated
by the user. Local Wi-Fi and Tailscale connections work without a Helmryth
account. A user may separately sign in on the desktop to enable the optional
**Use your phone anywhere** HTTPS connection.

## Data handling

- The iOS app stores the selected workstation address in iOS preferences and its
  pairing token in the iOS Keychain.
- The workstation remains the source of operators, transcripts, gates, credentials,
  SQLite data, and screen images. Helmryth's hosted control plane does not
  store a copy of that content.
- On a local Wi-Fi or Tailscale connection, phone traffic goes directly to the
  user's workstation. Tailscale is a separate service with its own privacy terms.
- If the desktop user enables optional hosted access, Helmryth stores the
  account email address, an internal account ID, and workstation installation
  metadata: an opaque installation ID, opaque client ID, workstation display name,
  operating system, app version, status, and security timestamps. It also stores
  opaque Cloudflare Tunnel/DNS resource IDs and redacted operational errors.
  These records are used only for sign-in, ownership, abuse prevention,
  provisioning, revocation, support, and reliability.
- The optional HTTPS route is proxied by Cloudflare to an outbound-only
  `cloudflared` connector on the user's workstation. Messages, gates,
  transcript responses, and screen frames pass through Cloudflare in transit,
  but are not written to the Helmryth control-plane database. Cloudflare may
  process IP addresses and connection/request metadata as Helmryth's service
  provider under Cloudflare's privacy terms.
- Connector tokens stay in the desktop operating system's encrypted credential
  store. Pairing and device tokens are not stored in the hosted control-plane
  database.
- The app contains no advertising or analytics SDKs, does not track users
  across other companies' apps or websites, and does not sell personal data.

Local HTTP connections should only be used on a network the user trusts. Tailscale and hosted HTTPS access are encrypted alternatives for untrusted or remote networks; neither makes a sleeping or powered-off workstation reachable.

## Retention, control, and deletion

Unpairing removes the workstation address and pairing token from the phone.
Revoking the phone in Helmryth's companion settings invalidates that device credential. Transcript deletion is controlled by the Helmryth installation
that stores the transcript.

Signing out of optional hosted access stops advertising the hosted address, revokes the workstation installation credential, and schedules deletion of its
Cloudflare Tunnel and DNS record. Account email, account identifiers,
installation/security metadata, and operational records are retained while
needed to operate and protect the service, and otherwise until the account
holder asks for deletion. Some minimal records may be retained when required
for security, fraud prevention, dispute resolution, or law.

To request a copy or deletion of hosted account data, open an
[Helmryth Support](../LEGAL_PROVENANCE.md) request
without posting an OTP, pairing code, device token, connector token, or other
secret. The maintainer will provide a private way to verify control of the email address. Deleting hosted account data does not delete transcripts stored on the user's own workstation.

## Support

Privacy questions can be opened at
[Helmryth Support](../LEGAL_PROVENANCE.md).
