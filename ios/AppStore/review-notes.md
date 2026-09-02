# App Review notes

Helmryth Mobile is the Reach surface for the Helmryth desktop application. The
primary same-network flow does not require an account. The desktop also offers
an optional passwordless email sign-in that provisions a private HTTPS address
for reaching that same workbench from another network; the iOS app itself does
not present a login screen.

To review the primary flow:

1. Install and start Helmryth on a Mac, Windows, or Linux workbench.
2. Open **Settings → Reach**, enable Reach, and choose **Start pairing**.
3. On the iPhone, choose **Scan QR Code**, scan the code shown by Helmryth Reach,
   review the workbench and address, and confirm pairing.
4. If the camera is unavailable, select the discovered workbench or enter the
   address and six-digit code shown by the workbench panel.
5. Create an operator on the desktop or with the `+` button in the iPhone roster,
   then send a message.

To review optional cross-network HTTPS access, enter an email in **Settings → Reach → Use your phone anywhere** on the desktop, enter the eight-digit
email code, enable Reach, and scan a newly generated QR code. The hosted
service authenticates and provisions the desktop; the phone still pairs to that
specific workbench and receives no universal Helmryth account credential.
The reviewer may use any email inbox they control. This optional path uses an
Helmryth-managed Cloudflare Tunnel and does not require Tailscale.

Optional cloud-workbench review requires an ascii.dev Box configured on the
workbench. For the paired phone, enable **Cloud workbench** under **Settings → Reach**, open an operator configured for **Cloud box**, choose its workbench
preview on iPhone, and confirm **Open live cloud workbench**. The app requests a
fresh HTTPS viewer session and does not use or store the provider API key.

For the direct remote alternative, both devices may be signed into the same
Tailscale network and the reviewer may enter the workbench's `.ts.net` MagicDNS
name. No purchase or subscription is required. The workbench is the source of
operator data and credentials, so a universal demo account cannot safely expose a
shared workbench to reviewers.
