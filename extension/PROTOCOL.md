# .memory/ Entity Memory Library Protocol v2

This protocol is the single contract for the memory library: entity format, retrieval, verification and gating are all governed by this document.
v2 is executed by the extension (`.pi/extensions/lazy-memory/`), replacing the skill version (v1). All v1 rules are inherited; v2 adds:

- 【Gating】a new "stale (re-verify)" state (timestamp rule)
- 【Verifiers】verifier abstraction: 5 built-ins, extended `validator` field values
- 【Verification records】naming rule for multiple records of the same entity on the same day

> Manual mode is active: `/memory` commands are the only triggers (auto mode is deferred; mode state exists in settings but has no behavior yet).
>
> Boundary: the extension registers no tools and re-implements nothing — grep, reading, writing, command execution and research all belong to the agent's own toolset.

## General principles

- No graphs, no cross-references; retrieval is always grep-based.
- Verification records are append-only, never overwritten (auditable).
- The library is passive: nothing is recorded, retrieved or verified unless explicitly requested.

## Directory layout

```
.memory/
├── entities/          # entities: one <id>.md per entity
└── verifications/     # verification: one <date>-<id>.md per record (same-day duplicates get -2, -3…)
```

## Entity file format

`entities/<id>.md`, the filename is the id (lowercase-hyphen). Front-matter has exactly three fields:

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

| Verifier id | Former layer | Judgment authority | Notes |
|---|---|---|---|
| format | L0 | agent | front-matter vs filename structure check — the agent runs it when verifying |
| conflict | L1 | agent | the agent reads the library and judges overlap/contradiction itself, then records its analysis as evidence |
| code | L2 | agent | the agent writes and runs the command itself (e.g. bash); records the command as `code: <command>` and its output as evidence |
| web | L3 | agent | the agent researches online and records its findings as evidence |
| user | L4 | user | the agent asks the user and records their confirmation |

`validator` field values: `format` / `conflict` / `code: <command>` / `web-research` / `local-evidence` / `user-confirm` (the last three stay compatible with v1 history).
Custom verifier fields are reserved (mode: custom + command); no protocol or storage change needed later.

The extension provides no verifier execution and no tools: all judgment is the agent's (and the user's). Verification records are appended by the agent writing files directly, following this protocol.

## Retrieval (semantic grep, executed by the agent)

The extension provides no search tool. The agent uses its own generic tools (bash grep / rg, read) — a dedicated grep tool the user may have works too:

1. Refine the retrieval intent.
2. Build search terms: original + synonyms + hypernyms + aliases, in both Chinese and English.
3. Grep entities/ full text, case-insensitive.
4. Too few hits → derive new terms from words in the hits, iterate until hits stabilize.
5. Read full files to judge relevance; carry only relevant ones into context.
6. No relevant hits → "no record of it", do not fabricate.

Constraints: cite entity ids when answering from memory (traceable); no vectors, no indexes, no precomputation.

## Gating (v2: four states)

Take the entity's newest verification record (max `checked_at`) and compare its time with the entity file mtime:

| Condition | State | Handling |
|---|---|---|
| latest record passed and newer than last entity edit | ✅ passed | use as fact |
| latest record failed and newer than last entity edit | ⚠️ failed | do not use as fact; may re-verify |
| no records at all | ❓ unverified | use with caution; verify before key decisions rely on it |
| latest record older than last entity edit | ⏳ stale (re-verify) | body changed, old verification no longer matches; re-verify or ignore |

Updating an entity body requires no deletion of records — the timestamp rule automatically downgrades it to "stale (re-verify)".

## Commands & triggers (the extension's only surface)

The extension registers no tools — the model works with generic tools only (grep, read, write, bash). User commands are the only entry points:

| Command | Purpose | Behavior |
|---|---|---|
| `/memory` | overview | prints mode + 4-state distribution (TUI only, no injection) |
| `/memory record` | settle memory (create/update) | injects the settlement prompt — the agent reads this protocol, searches entities, and writes/updates files itself, then commits per git conventions |
| `/memory query [terms]` | retrieval | injects the retrieval prompt — the agent searches itself and reports hits with gate states |
| `/memory verify [id]` | verification | collects unverified/stale entities and injects the verification prompt — the agent verifies each one itself and appends records by writing files |
| `/memory mode [auto\|manual]` | switch mode | writes settings.json only; auto-mode behavior is not implemented yet |

Injected prompts point the agent at this document — the protocol is the agent's operating manual, read on demand, never embedded in the context.

Retrieval: the agent follows the retrieval protocol below using its own search tools.

## Correcting a failed fact

1. Do not edit the entity body (auditable); if the body genuinely needs an update, follow the update flow and accept the "stale" state.
2. Append a failed record with the overturning basis in evidence (source, command output, user's exact words).
3. If the fact still has value, create a new entity; gating automatically excludes the old one.

## Changes and audit

- `.memory/` lives inside the git repository: entity/verification changes are natively revertable and traceable.
- Commit messages should follow Conventional Commits with the `memory:` scope (documentation type).