# GEMINI.md

> **Single source of truth:** all project rules for AI assistants live in
> [`AGENTS.md`](AGENTS.md). Read it in full before any change — it contains the 23 Hard Rules,
> quality gates, code conventions, file-placement / repo-root hygiene rules, the repository map
> and the local development access notes that used to live in this file.

For Oracle production work, follow `AGENTS.md` → "Canonical Oracle production operations" and
`docs/ops/ORACLE_VPS_OPERATIONS_KB.md`. Use `/home/ubuntu/OmniRoute-src` as the canonical source
checkout and the tested deploy orchestrator; never deploy from the legacy workdir or bypass a
failed qualification gate.

Gemini-specific notes:

- Skills activate via the `activate_skill` tool (skill metadata is loaded at session start and
  the full content is activated on demand).
- There are no other Gemini-only rules today. Do not re-add project rules here — edit
  `AGENTS.md` instead, so every assistant sees the same instructions.
