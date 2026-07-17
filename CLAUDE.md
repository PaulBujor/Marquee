# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @AGENTS.md for the full project guidance — tech stack, commands, architecture, and conventions. `AGENTS.md` is the single source of truth read by every AI tool; keep it (not this file) up to date.

## Claude Code notes

- Package manager is **pnpm** (see `packageManager` in `package.json`). Use `pnpm install`, `pnpm <script>` — not npm.
- Before proposing a commit, run `pnpm lint && pnpm check && pnpm build` — this mirrors the CI gate (`.github/workflows/ci.yml`, Node 22, pnpm).
- Work is planned in Linear team **MRQ** (project "Core App"). The Linear MCP is available for reading/updating `MRQ-<n>` issues; branch names follow `paul/mrq-<n>-short-slug`.
