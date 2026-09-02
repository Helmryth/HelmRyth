# Bring Your Own VPS

Helmryth can turn a Linux server you already own into an operator's workstation. The operator process stays on your machine; Docker's own SSH transport reaches the daemon on the VPS, and each operator gets one managed, hardened Cua container there — a Linux desktop it can see and control. SSH is the only credential involved and the only surface exposed: Helmryth never opens a public port on the VPS, never stores your SSH key or passphrase, and never runs an operator remotely.

## What works

- A per-operator Linux desktop in a managed container on your VPS, driven through the official Cua tools.
- Live screen preview in the Workbench panel and in transcripts, same as a Box.
- Explicit **Cloud** with the **Self-hosted VPS** backend provisions or starts the container. **Auto** reuses
  a ready container by default; an off-by-default **Start VPS automatically** switch lets that operator prepare
  or wake its managed container when needed.
- Interactive **Take control** through a temporary SSH tunnel. The app binds noVNC only to a random
  `127.0.0.1` port on your workstation, closes the tunnel with the viewer, and never publishes VNC on the VPS.

## Prerequisites

- **Locally:** a `docker` CLI, version 18.09 or newer (that is when `docker -H ssh://` shipped). The Docker
  daemon does not need to run locally — only the CLI is used.
- **On the VPS:** a running Docker daemon (`dockerd`) on x86_64 Linux.
- **The SSH user** must be in the `docker` group on the VPS, so `docker info` works without sudo.

Be clear-eyed about that last point: membership in the `docker` group is root-equivalent on that machine.
Anyone who can talk to the daemon can mount the host filesystem into a container. Using this feature means
trusting the VPS — and whoever else can reach its Docker daemon — completely. Give operators a dedicated server,
not one that also holds things you would not hand to the run.

## The required SSH config alias

Helmryth connects only through a named alias in your `~/.ssh/config` — you type the alias into
App Settings → Connections, nothing else. The alias block is load-bearing, not a convenience: every operator
action becomes a `docker exec` over SSH, and without multiplexing each one pays a full SSH handshake; without
keepalives and a connect timeout, a VPS that drops off the network hangs the run instead of failing it.
Set the block up like this:

```
Host my-vps
  HostName 203.0.113.7
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h-%p
  ControlPersist 60m
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 10
```

- `ControlMaster`/`ControlPath`/`ControlPersist` — every action is a docker-over-SSH exec; multiplexing turns
  per-command connects into milliseconds over one persistent connection.
- `ServerAliveInterval`/`ServerAliveCountMax`/`ConnectTimeout` — a dropped VPS must fail fast (under a
  minute, and ten seconds to connect), not hang a turn waiting on a dead TCP session.

**Host key first, by hand.** Connect once manually before pointing Helmryth at the alias:

```sh
ssh my-vps true
```

That puts the host key in `known_hosts` on your terms. The app never auto-accepts a host key — an alias whose
host is unknown simply fails until you have done this once.

## Security

- **No public ports.** The managed container is created with no published ports, and Helmryth refuses to
  use a container that publishes any — the check runs before every attach, not just at creation. Live view
  reaches the container's private bridge address through SSH and is loopback-only on your workstation.
- **Firewall the VPS to SSH only**, ideally from your IP. Nothing Helmryth does needs any other inbound
  port open, so anything else open is pure attack surface.
- **Nothing sensitive is stored.** The only thing Helmryth persists is the alias name itself
  (`~/.helmryth/config.json`); keys, passphrases, and agent state stay with SSH. The alias is also kept
  off paired phones — the companion reports configured-or-not, never the name.
- The container itself runs hardened: capabilities dropped, private network/IPC/cgroup namespaces, no host
  mounts, and memory/CPU/pid limits. A container missing any of that — including one someone created under
  the managed name — is refused, not repaired.

## Container lifecycle

Each operator owns one container on the VPS, named `helmryth-vps-<operator>-<hash>` — stable across restarts and independent of the operator label.

- **Provision** (choosing **Cloud** for the operator, or the panel's button): builds the pinned Cua image on the
  VPS if needed, creates the container if missing, starts it if stopped, and waits until the desktop answers.
- **Start** only wakes an existing stopped container; it never creates one.
- **Sleep** stops the container. The VPS stops spending CPU on it; the filesystem stays put.
- **Remove** is yours, done by hand when an operator no longer needs the server:
  `docker -H ssh://my-vps rm -f <container>`. Helmryth never deletes a container on its own.

What survives what: sleep/start preserves the container's filesystem; removal — including the recreate that follows a Cua image upgrade, since a container pinned to an old image is refused rather than reused — wipes it. Treat the container filesystem as **disposable**: anything an operator must keep should leave the VPS (pushed, uploaded, or pasted back into chat) before the container is removed.

An operator set to **Auto** is lifecycle-read-only by default. It attaches only when the container is already
running and verified. If no local fallback exists, the turn now explains why the VPS was unavailable instead
of silently running without a workstation. Enable **Start VPS automatically** per operator to let Auto prepare or wake
that operator's managed container; the switch is deliberately off by default.

## Troubleshooting

Work up the same path the app takes, cheapest signal first:

1. **The alias works by hand:** `ssh my-vps true` returns silently. A password prompt means the key/agent is
   not set up; a host-key prompt means the first manual connect has not happened yet.
2. **Docker over SSH reaches the daemon:** `docker -H ssh://my-vps info` prints server details. A permission
   error means the SSH user is not in the `docker` group.
3. **Provision:** choose **Cloud** with the **Self-hosted VPS** backend in the operator's Workbench panel. The
   first provision pulls and builds the Cua image on the VPS, which can take minutes; later ones are fast.
4. **Read the status states.** The panel surfaces exactly what the server found, in check order: alias not
   configured → daemon unreachable → image missing → container missing / stopped → container unmanaged or
   unsafe (ports, mounts, hardening) → desktop not ready. Each message names the step to fix.
