# Memory Library Protocol — Entities

Entity files live in `.memory/entities/`, one `<id>.md` per entity. Read this file together with the operation manual before operating on `.memory/entities/`.

## Library layout (shared)

```
.memory/
├── entities/          # entities: one <id>.md per entity
└── verifications/     # verification: one <date>-<id>.md per record (same-day duplicates get -2, -3…)
```

## Entity file format

The filename is the id (lowercase-hyphen). Front-matter has exactly three fields:

| Field | Value | Notes |
|---|---|---|
| id | matches filename | unique identifier |
| kind | tool / person / project / concept / decision | type |
| sources | URL / local path / conversation reference | attribution |

Files that do not conform to this format (malformed or missing front-matter, or missing id/kind) are ignored by the extension.

Body rules:

- One independently verifiable assertion per sentence, written with concrete words (grep-able), no pronouns.
- No hedging ("maybe", "I think"); uncertain content goes into `sources`, never the body.
- The body carries no trust state; trust is derived from the latest verification record (gating rules live in verifications.md).