# Memory Library Protocol — Shared Rules (Schema)

Shared contract for the memory library: layout, entity format, verification record format, verifiers, gating.
The operation manuals (record.md / query.md / verify.md) reference this file; read it together with the manual before operating on `.memory/`.

## Directory layout

```
.memory/
├── entities/          # entities: one <id>.md per entity
└── verifications/     # verification: one <date>-<id>.md per record (same-day duplicates get -2, -3…)
```

## Entity file format

`entities/<id>.md`; the filename is the id (lowercase-hyphen). Front-matter has exactly three fields:

| Field | Value | Notes |
|---|---|---|
| id | matches filename | unique identifier |
| kind | tool / person / project / concept / decision | type |
| sources | URL / local path / conversation reference | attribution |

Body rules:

- One independently verifiable assertion per sentence, written with concrete words (grep-able), no pronouns.
- No hedging ("maybe", "I think"); uncertain content goes into `sources`, never the body.
- The body carries no trust state; trust is derived from the latest verification record (see Gating).

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