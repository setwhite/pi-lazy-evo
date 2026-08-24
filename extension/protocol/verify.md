# Memory Library Protocol — Verification

Triggered by `/memory verify [id]` for all entities pending verification (unverified / stale), or the specified id. Read this manual and schema.md before appending any record.

## Enforcement

- The extension provides no verifier execution and no tools: all judgment is the agent's (and the user's).
- Evidence is required on every record; append `passed` only when you actually verified, otherwise append `failed` with the reason.
- Each verification of an entity is a new append — never touch an existing record.
- Recording format, verifier semantics and the timestamp rule live in schema.md.

## Correcting a failed fact

1. Do not edit the entity body (auditable); if the body genuinely needs an update, follow the update flow and accept the "stale" state.
2. Append a failed record with the overturning basis in evidence (source, command output, user's exact words).
3. If the fact still has value, create a new entity; gating automatically excludes the old one.

## Commits

`.memory/` lives inside the git repository: verification changes are natively revertable and traceable. Commit messages follow Conventional Commits with the `memory:` scope (documentation type).