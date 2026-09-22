---
name: orchestration
description: "This setup's dispatch rules for running subagents against a plan in docs/plans/ — the tier table that picks a model per task, slice-by-line-range briefs, diff-only review, and the read caps. Use when assigning plan tasks to subagents, choosing a tier for one, setting up a reviewer, or writing a plan subagents will execute. Prefer this over the Anthropic bundle's same-named skill, which carries none of these conventions."
---

# Orchestration — slicing context for subagents

For dispatching against a written plan. One-off inline calls just need the Delegation section of `~/.kimi-code/AGENTS.md`.

## The economics

Every subagent cold-starts and re-ingests everything it is pointed at, and every reviewer
re-ingests what the implementer just read. A 1461-line plan handed to 6 agents cost ~110k
tokens on re-ingest alone, before any work happened. The session counter aggregates parent
plus all subagents, so a cheaper model tier does not reduce this — only cutting what each
agent reads does.

Two consequences, in this order:

1. **Do not dispatch what is cheaper inline.** Cold start is a fixed cost per spawn. One
   grep, one short file, one quick command: do it yourself. Dispatch when the output is
   large and the answer is small. This weighs one task against one spawn — several small
   tasks in the same module go out as one batched dispatch, which pays the cold start once
   and defeats the argument rather than losing to it.
2. **Reuse before spawning.** A follow-up in an area an agent already loaded goes back to
   that agent — resume it by passing its agent id as `resume` to the `Agent` tool. A second spawn re-pays the cold start and
   re-reads the same files.

## Dispatch

- **Recurring roles go to standing agents** (`verify`, `explore`, `impl`, `diff-review`,
  `security-reviewer`). They carry their own procedure and return contract, so the prompt
  is a path plus a command — not a brief. See the Delegation section of `~/.kimi-code/AGENTS.md`.
- **Threshold.** Under ~300 lines (~4k tokens): pass the whole file, carving saves nothing.
  Over that: slice.
- **Slice contents.** Per-task brief = shared safety rules + file structure + that task's
  section + acceptance criteria. Write each slice to a temp file, pass the path.
- **Do not read the slice you generated.** Cut with `sed -n`, hand over the path. Reading it
  puts the section in your context anyway, which is the cost you were avoiding.
- **Slice by line range, never heading regex.** Fenced code blocks contain `#` lines that
  break a naive heading split.
- **Wording:** "Read `<path>`. That file is your complete brief. Do not read the full plan."
- **Reviewers get diffs, not source.** "Review `git --no-pager diff` against the acceptance
  criteria in `<slice path>`. Do not read the plan or re-read source unless the diff is
  ambiguous." This is the single biggest saving. Where a unit's correctness is defined
  outside its diff — a cross-branch port, a field mapping living in a normalizer — name that
  unit as an explicit exception with the reason. Do not lift the rule for everyone.
- **Cap the reads that survive slicing.** Rendered mockups and design HTML are screenshotted
  in a browser, never read as text. Logs and progress files are grepped, never `cat`ed.
  Standards documents are read by resolved line range — resolve those ranges once, in the
  orchestrator, and write them into the briefs.
- Delete the brief directory when the run ends. It is scratch, not an artifact.

## The ledger

**You are the only writer of the plan's ledger.** Never tell a subagent to update it:
parallel implementers collide on the same table rows, and the sub's report is exactly what
the row is written from — so writing it yourself costs one edit and no coordination.

Write the row from the sub's report, at the moment you accept that report:

- Dispatched → `WIP`. Implementer reported, reviewer not yet run → `REVIEW`.
- Review passed → `DONE`, with the commit sha and the verification output line the sub
  returned as Evidence. A sub that reports "tests pass" without a line has not given you
  Evidence — ask for the line rather than inventing one.
- Sub blocked, or you descoped the task → `BLOCKED` / `DROPPED` with the reason.

No `WIP` row survives the run. Enum and cell rules: the `plan-lifecycle` skill; a Stop hook enforces them.

**The plan file also moves.** Open the run by setting the plan status to `IN PROGRESS` and
`git mv`-ing the file into `<plans>/WIP/`; close it into `<plans>/completed/`. Do this
*before* cutting any slices — a brief pointing at the pre-move path is stale the moment the
file lands somewhere else, and a sub cannot recover from a path that no longer resolves.

## The orchestrator's own budget

You are the premium tier in the run and the only context that persists across it. Protect it.

- Never read a file to check work a sub already reported on. The report is the artifact.
- Never read the diff yourself to decide whether to trust a review — dispatch a second
  reviewer if the first is unconvincing.
- Resolve line ranges and file lists with `grep -n` / `--stat`, not by reading.
- Keep per-sub replies capped (the return contract lives in the Delegation section of `~/.kimi-code/AGENTS.md`). A sub that hands
  back its transcript costs you twice: once to produce it, once to hold it.

## Tier

**You set it, on every dispatch.** A tier named in prose does nothing. Tiers are
harness-neutral — `fast`, `standard`, `strong`, `max` — and `~/.kimi-code/TIERS.md` maps each
to this harness's model and effort, and says how a dispatch applies them.

**Implementation tier is a binary.** `standard` only for transcription-grade tasks — the
plan ships the runnable code, the agent transcribes and runs tests, and none of the judgment
triggers below apply. Everything else implements at `strong`. Do not argue categories per
dispatch; if it is not transcription, it is `strong`.

**Judgment triggers** — `strong` even when the plan ships the code:

- State machines and stateful lifecycle logic (mount/unmount ordering, subscription
  teardown, reconnect paths).
- A11y and focus machinery (focus traps, roving tabindex, live regions).
- Security-adjacent code: auth, permissions, secret handling.
- Deletions where the agent must itself verify nothing still references the removed code,
  or that cannot be reverted by discarding one file. A deletion the plan names explicitly
  is transcription.
- Spec contradictions the plan leaves to the implementer. Prefer pulling these back to the
  orchestrator, which holds the full plan; `strong` only if resolution is genuinely delegated.

| Work | Tier |
|---|---|
| Run commands, extract failures, transcribe | `fast` |
| Search, locate, inventory | `fast` |
| Implement: plan ships the code, no trigger above | `standard` |
| Implement: any judgment trigger, or design decisions remain | `strong` |
| Review, verify, judge | implementer's tier or higher |
| Live, silent-failing, or hard to revert | `max` |

- Reviewer tier is **≥ the tier that wrote the code** — never below, and raise it above
  for a risky diff.
- Push higher regardless of code completeness for tasks that **fail silently**, touch
  anything **live**, or **cannot be reverted by discarding one file**.
- Record one line of rationale wherever you depart from the plan's suggested tier.

## Writing plans meant for subagent execution

- Keep shipping full runnable code inline per task. Fat plans are correct — they make
  implementers transcribe rather than design. Slice at dispatch time instead of thinning
  the plan.
- Every task section self-contained. No "same helper as Task 3", no "see above" — a
  cross-reference forces the agent to pull neighbouring sections back in and destroys
  the saving.
- Stable `### Task N:` headings, shared invariants in one short preamble near the top, so
  extraction is a mechanical line-range cut.
- Acceptance criteria must be checkable **from a diff alone**, since that is what the
  reviewer gets.
- Include a per-task **tier suggestion table** with a `why` column. It is an input to your
  decision, not binding.
- **Seed the ledger, one row per task, above the preamble.** Above, so the preamble slice
  that goes into every brief does not carry status with it. Seeded, because a row added
  mid-run cannot be told from a task nobody planned.
- Each task carries a `**Verify:**` line naming the exact command. It is what a sub runs to
  earn `DONE`, and what you paste into the Evidence cell.

## Worked example

Plan is 1,461 lines. Shared invariants live in lines 1–48. Task 7 is lines 412–509.

```bash
grep -n '^### Task ' plan.md
```

```bash
mkdir -p .briefs && { sed -n '1,48p' plan.md; sed -n '412,509p' plan.md; } > .briefs/task7.md
```

Do not `cat` the result. Implementer — agent `impl`, tier `standard`:

> Read `.briefs/task7.md`. That file is your complete brief. Do not read the full plan.

Reviewer — agent `diff-review`, tier `standard`:

> Review `git --no-pager diff` against the acceptance criteria in `.briefs/task7.md`.

Both carry their own return contract, so the prompt stops there.

**Batching small tasks.** Tasks 7 and 8 are each too small to justify their own spawn but
touch the same module and sit at the same tier. One brief, one agent — the cold start is
paid once:

```bash
mkdir -p .briefs && { sed -n '1,48p' plan.md; sed -n '412,509p' plan.md; sed -n '510,548p' plan.md; } > .briefs/batch-7-8.md
```

> Read `.briefs/batch-7-8.md`. It contains Tasks 7 and 8. Complete both, commit each
> separately, and report status, sha and Verify output per task.

Per task, because you write one ledger row per task from that single report.

```bash
rm -rf .briefs
```
