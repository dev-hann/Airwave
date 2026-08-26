# Architecture Decision Records

Every structural decision gets an ADR here **before** the work starts. An ADR answers *why* — code and the architecture docs answer *what/how*. Agents must read relevant ADRs before reversing or extending a past decision, and must not silently contradict one.

## Format

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN | Rejected
- Date: YYYY-MM-DD

## Context
(forces at play, constraints, alternatives considered)

## Decision
(what we chose, in one or two sentences)

## Consequences
(what becomes easier, what becomes harder, what is now forbidden/required)
```

## Rules

- Sequential numbering, kebab-case filename: `0002-mp3-to-hls-stream.md`.
- Status `Accepted` when work begins; flip to `Superseded by NNNN` (never delete) when reversed.
- A new ADR that reverses an old one must link the old one and state what changed in the context.
- Doc-sync: if an ADR contradicts code or another doc, the same commit fixes both.

## Index

- 0001 — ADR process itself
- 0002 — Raw-MP3 → HLS live stream (v1.3.0)
- 0003 — Remove SendSpin synchronized-playback subsystem
- 0004 — Frontend TypeScript + Pinia + service-layer migration
