# Memory Library Protocol — Record (Settle)

Triggered by `/memory record`. Read this manual and schema.md before writing anything into `.memory/`.

## Principles

- The library is passive: nothing is recorded unless explicitly requested.
- Only durable conclusions worth citing later go into the library; transient details never do.

## Writing (create / update)

- Create: write `entities/<id>.md` for a new entity; validate id and kind first (see schema.md).
- Update: rewrite the body with the new assertions; append new origins to `sources` separated by `；`, never duplicating an origin already present.
- Updating a body deletes no verification records — the timestamp rule (see schema.md) automatically downgrades the entity to `stale (re-verify)`.
- Changing an id means creating a new entity; do not rename files.

## Boundary with verification records

Verification records are appended only by the verification flow (verify.md). The settle flow never writes, modifies, or deletes anything under `.memory/verifications/`.

## Commits

`.memory/` lives inside the git repository: changes are natively revertable and traceable. Commit messages follow Conventional Commits with the `memory:` scope (documentation type).