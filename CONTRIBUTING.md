# Contributing to Helmryth

Thanks for helping improve Helmryth.

## Scope

- Keep changes small and focused.
- Match the existing workbench vocabulary: operator, crew, run, cadence, capability, gate, and workbench.
- Do not introduce new runtime dependencies without a clear reason.
- Preserve external provider names and required legal provenance.

## Local setup

Requirements: Node 24+, pnpm, and at least one supported operator CLI.

```bash
pnpm install
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

## Verification

Run the relevant checks before handing off a change:

```bash
pnpm check:brand
pnpm typecheck
pnpm test
pnpm check:electron
pnpm check:packaged
```

These are the five the `typecheck + test` job runs, in the order it runs them,
on macOS, Linux and Windows. Running a subset locally means finding out about
the rest from a red pull request.

For docs-only changes:

```bash
pnpm --dir apps/docs build
node scripts/check-brand-residue.mjs
```

## Platform notes

- Keep the harness portable.
- Keep macOS-only code behind platform guards.
- Keep the docs build light-first and free of inherited marketing assets.
- Do not commit generated build output unless the workflow explicitly requires it.

## Before you open a pull request

- Typecheck passes.
- Relevant tests pass.
- Docs build passes for docs changes.
- Brand residue scan passes for public-copy changes.
- Required notices remain intact.
