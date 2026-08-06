---
name: marquee-stacks
description: >
  Marquee's conventions for stacked PRs with gh-stack — branch naming, PR titles, how CI
  behaves on a stack, merge method, and the manual restacking workarounds gh-stack retires.
  Use alongside the gh-stack skill whenever work in this repo is split across dependent
  branches or PRs, or when a stack is checked out.
---

# Stacked PRs in Marquee

The [`gh-stack`](../gh-stack/SKILL.md) skill (installed from `github/gh-stack`) is authoritative
for command mechanics — non-interactive flags, exit codes, conflict recovery. **Read it first.**
This file only covers where Marquee differs from its defaults.

## Repo facts

- The extension is per-machine, not per-repo: if `gh stack` is missing, run
  `gh extension install github/gh-stack`.
- Trunk is `main`. One remote (`origin`), so `--remote` is never needed.
- The repo squash-merges and deletes branches on merge.
- One-time local setup: `git config rerere.enabled true` (`gh stack init` does this anyway).

## Branch naming

Marquee's convention **overrides** the `<topic>/<concern>` pattern in
`gh-stack/references/stack-design.md`:

```
paul/mrq-<n>-short-slug
```

Prefer one Linear issue per layer, so each PR closes its own `MRQ-<n>`:

```bash
gh stack init paul/mrq-180-episode-schema
gh stack add paul/mrq-181-episode-api
gh stack add paul/mrq-182-episode-ui
```

When a single issue genuinely spans layers, suffix the slug (`-1-schema`, `-2-api`) rather than
splitting the issue reference.

## PR titles and bodies

`gh stack submit --auto` generates titles from commits or the branch name — it has no title flag.
Marquee titles follow Conventional Commits with the issue in the subject:

```
feat(tracking): show when a movie/episode was watched (MRQ-170)
```

So after the first submit, fix each title:

```bash
gh stack submit --auto
gh pr edit <number> --title "feat(scope): subject (MRQ-<n>)"
```

Never add Claude attribution — no `Co-Authored-By` trailer in commits, no "Generated with Claude
Code" in PR bodies. Keep `MRQ-` references out of source comments; commits and PRs are the place
for them.

## CI on a stack

`.github/workflows/ci.yml` triggers on `pull_request: branches: [main]`. Per the gh-stack FAQ,
GitHub evaluates a PR that belongs to a **Stack** as if it targeted the stack base, so once
`gh stack submit` has linked the PRs, the full gate (`lint → check → build → test:coverage`) runs
on *every* layer — and a layer can't merge until every PR below it is green too.

This only holds for real Stacks. A hand-chained PR whose base is just another feature branch gets
no gate until it retargets to `main`, which is why pre-gh-stack chains here had to be verified
locally. Confirm on the first stack that the check actually appears on an upper PR.

Do not run the whole gate locally; push and let CI run it. For a quick local signal, run the
targeted piece — `npx vitest run --maxWorkers=4` (always cap the workers).

Two Marquee-specific things to watch when a stack rebases:

- **Drizzle migrations.** `drizzle/NNNN_<name>.sql` is numbered and recorded in
  `drizzle/meta/_journal.json`. Two layers that each add a migration will collide on the journal
  and the numbering on every rebase. Keep schema changes in one layer where you can; if you can't,
  expect to re-resolve `_journal.json` and verify the numbering after any restack — and keep each
  `drizzle/down/NNNN_<name>.down.sql` in lockstep.
- **Stale `.svelte-kit`.** `pnpm check` / `pnpm test` run `svelte-kit sync` themselves, but the
  raw `npx vitest` above does not. After navigating to another layer, run
  `pnpm exec svelte-kit sync` once so the generated `.svelte-kit/tsconfig.json` matches the
  branch.

## Merging

```bash
gh stack merge <pr-number> --yes --squash   # that PR and every unmerged PR below it
gh stack sync --prune                       # then resync and drop merged local branches
```

`gh pr merge` cannot merge a stack — always `gh stack merge`. Merging is all-or-nothing over the
set, and GitHub retargets and rebases the remaining layers itself, so no manual cleanup.

If `submit` exits **9**, stacked PRs aren't enabled for this repository — that's a GitHub feature
availability issue, not a CLI problem. Say so rather than falling back to hand-rolled stacks.

## Workarounds this replaces

These were the manual-stack survival tactics. With `gh stack` driving the stack, don't reach for
them:

| Old manual tactic                                            | Now                                 |
| ------------------------------------------------------------ | ----------------------------------- |
| `git rebase --onto <new-parent> origin/<old-parent> <child>` | `gh stack rebase --upstack`         |
| Forward-merge cascades (`git merge <parent>`) to avoid force-pushing a pushed stack | `gh stack rebase` then `gh stack push` (per-branch `--force-with-lease`) |
| Avoiding `--delete-branch` on merge so the child PR isn't closed | `gh stack merge` — GitHub retargets the children |
| Waiting for a retarget before CI would run on a child PR      | CI runs on every layer immediately  |

Rewriting a layer that's already pushed is now routine, not a hazard: `gh stack push` updates each
branch with `--force-with-lease`. If a permission prompt blocks that, ask for it — don't fall back
to the forward-merge cascade.

Worktrees under `.claude/worktrees/` keep their own git state; for branches managed there, see
"Driving stacks from another tool or worktree" in `gh-stack/references/troubleshooting.md`
(`gh stack link`).

## Updating the vendored skill

`.claude/skills/gh-stack/` is installed verbatim from upstream and pinned in its frontmatter — do
not hand-edit it, put Marquee-specific guidance here instead.

```bash
gh skill update gh-stack
```
