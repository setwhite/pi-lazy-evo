# Memory Library Protocol — Retrieval (Query)

Triggered by `/memory query [terms]`. Read this manual and schema.md before searching `.memory/entities/`.

## Retrieval (semantic grep, executed by the agent)

The extension provides no search tool. The agent uses its own generic tools (bash grep / rg, read):

1. Refine the retrieval intent.
2. Build search terms: original + synonyms + hypernyms + aliases, in both Chinese and English.
3. Grep entities/ full text, case-insensitive.
4. Too few hits → derive new terms from words in the hits, iterate until hits stabilize.
5. Read full files to judge relevance; carry only relevant ones into context.
6. No relevant hits → "no record of it", do not fabricate.

Constraints: cite entity ids when answering from memory (traceable); no vectors, no indexes, no precomputation.

## Reporting format

For each hit, report: entity id, kind, gate state (see schema.md), and the relevant assertions. Cite entity ids when answering from memory; state clearly when there is no record.