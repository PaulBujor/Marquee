# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @AGENTS.md for the full project guidance — tech stack, commands, architecture, and conventions. `AGENTS.md` is the single source of truth read by every AI tool; keep it (not this file) up to date.

## Claude Code notes

- Before proposing a commit, run `npm run lint && npm run check && npm run build` — this mirrors the CI gate (`.github/workflows/ci.yml`, Node 22).
- Work is planned in Linear team **MRQ** (project "Core App"). The Linear MCP is available for reading/updating `MRQ-<n>` issues; branch names follow `paul/mrq-<n>-short-slug`.
