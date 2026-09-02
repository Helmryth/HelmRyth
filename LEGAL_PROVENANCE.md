# Helmryth Legal Provenance

This repository ships as `Helmryth`, but it contains derivative work that
retains upstream notices, third-party license files, and packaging provenance
required by the Apache-2.0 license and bundled dependencies.

## What this file is for

- It names the current product identity: `Helmryth`.
- It preserves the upstream attribution chain instead of erasing it.
- It points maintainers to the locations that must stay accurate when the
  product is redistributed.

## Attribution chain

- Current product name: `Helmryth`
- Upstream notice retained in [NOTICE](NOTICE)
- Repository license text retained in [LICENSE](LICENSE)
- Bundled third-party provenance retained under [third_party](third_party)

## Bundled third-party materials

The repository contains bundled or staged third-party materials with their own
license and provenance records, including:

- `third_party/cloudflared`
- `third_party/cua-driver`
- `third_party/playwright-injected`

Do not remove or rewrite those notices when rebranding the product. Rebranding
changes the product identity; it does not replace upstream or third-party
license obligations.

## Release and packaging notes

- Release workflows now require explicit `HELMRYTH_*` repository variables and
  secrets before they publish or assemble release artifacts.
- Public documentation in this tree intentionally avoids pointing at inherited
  release repositories or support channels.
- If you publish Helmryth from a new repository, update the owner-facing URLs
  in docs and release settings without altering the retained license notices.

## Scope

This file documents source and packaging provenance only. It does not assert
private contractual rights, trademark ownership, or commercial transfer terms
that are not evidenced inside this repository.
