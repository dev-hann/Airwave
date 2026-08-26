# 0001. Adopt ADRs for structural decisions

- Status: Accepted
- Date: 2026-08-26

## Context

This fork is developed primarily by AI agents. "Why is it built this way" lived only in git history and chat sessions, so every new session re-derived or accidentally reversed past decisions (e.g. Sonos/SendSpin/SoundCloud removals being quietly re-proposed). Mature agent-driven repos (k8s KEPs, rust-analyzer dev docs) record decisions durably.

## Decision

Structural decisions are recorded as ADRs under `docs/decisions/` using the format in its README, written before implementation begins. Old decisions are back-filled where the context is still recoverable.

## Consequences

- Agents must check the index before proposing changes that contradict prior decisions, and must add a new ADR when reversing one.
- Slightly more ceremony per structural change; trivial changes (bug fixes, refactor within an accepted decision) need none.
