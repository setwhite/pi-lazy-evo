# Memory Library Protocol — Verifications

Verification records live in `.memory/verifications/`, read this file together with the operation manual before appending any record. Entity file format lives in entities.md.

## Verification record format

`verifications/<date>-<id>.md`, append-only — never modify old files.
When the same entity gets multiple records on the same day, the filename gets a suffix: `<date>-<id>-2.md`, `-3.md`, …

| Field | Value |
|---|---|
| target | entities/<id>.md |
| validator | see Verifiers |
| checked_at | ISO timestamp |
| result | passed / failed |
| evidence | verifiable basis |

Records that do not conform (non-entities/<id>.md target, invalid result, or non-ISO `checked_at`) are ignored by the extension.

## Verifiers (v2: layered abstraction as a verifier set)

| Verifier id | Judgment authority | Notes |
|---|---|---|
| format | agent | front-matter vs filename structure check |
| conflict | agent | read the library and judge overlap/contradiction, record the analysis as evidence |
| code | agent | write and run the command yourself (e.g. bash); record the command as `code: <command>` and its output as evidence |
| web | agent | research online and record your findings as evidence |
| user | user | ask the user and record their confirmation |

`validator` field values: `format` / `conflict` / `code: <command>` / `web-research` / `local-evidence` / `user-confirm` (the last three stay compatible with v1 history).
Custom verifier fields are reserved (mode: custom + command); no protocol or storage change needed later.

## Gating: the four states

Take the entity's newest verification record (max `checked_at`) and compare its time with the entity file mtime:

| Condition | State | Handling |
|---|---|---|
| latest record passed and newer than last entity edit | ✅ passed | use as fact |
| latest record failed and newer than last entity edit | ⚠️ failed | do not use as fact; may re-verify |
| no records at all | ❓ unverified | use with caution; verify before key decisions rely on it |
| latest record older than last entity edit | ⏳ stale (re-verify) | body changed, old verification no longer matches; re-verify or ignore |

Updating an entity body requires no deletion of records — the timestamp rule automatically downgrades it to "stale (re-verify)".