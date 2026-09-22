---
name: executing-plans
description: Execute a written implementation plan task by task — open the run, decide per task whether to dispatch or implement inline, keep the ledger, close the run. Use when you have a plan to implement, are resuming a partly-done plan, or are picking up a plan from docs/plans/.
---

# Executing Plans

Load plan, review critically, execute every task, close the run.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

This is the entry point for running a plan. It pulls in two references at the points they
bind: `plan-lifecycle` for ledger and folder rules, `orchestration` for dispatch, slicing
and tiers. Neither of those runs a plan on its own — start here.

## Step 1: Load and review

1. **Invoke the `plan-lifecycle` skill** (Skill tool). Status enums, ledger cell rules and
   the folder layout come from there, and a Stop hook enforces them.
2. Read the plan file.
3. **Read its Ledger first** — it names the resume point. Rows already `DONE` are not re-run.
4. If the plan has no ledger, seed one before executing anything (`writing-plans` has the
   template) and say so — an unseeded plan has no baseline.
5. Review critically. Raise concerns with your partner before starting; otherwise create
   TodoList and proceed.

## Step 2: Open the run

Before the first task, in one commit: set **Plan status** to `IN PROGRESS` and `git mv` the
file into the `WIP/` folder beside it.

```bash
mkdir -p docs/plans/WIP && git mv docs/plans/<plan>.md docs/plans/WIP/<plan>.md
```

Move first, dispatch second — a brief naming the pre-move path is stale the moment the file
lands elsewhere, and a sub cannot recover from a path that no longer resolves. Every later
path reference, yours and any brief's, uses the new path.

## Step 3: Decide dispatch — per task, not per run

**Invoke the `orchestration` skill now, before deciding.** It owns the slice threshold, the
line-range cut, standing-agent routing, and the tier table. Do not improvise a brief or pick
a tier from memory.

the Delegation section of `~/.kimi-code/AGENTS.md` standing-authorizes dispatch to every standing agent (`verify`,
`explore`, `impl`, `diff-review`, `security-reviewer`). Treat those as requested by the
owner — dispatch without asking per task.

**Read the plan's `| Task | Tier |` table first.** A row naming a tier is a dispatch
decision already made. It is not yours to re-open. `~/.kimi-code/TIERS.md` maps it to a model,
including the model names older plans carry in a `| Task | Model | Effort |` table.

For a task the table does not cover:

- **Dispatch** when the output is large and the answer small, or when tasks are independent
  enough to run concurrently. Reuse an agent that already loaded the area (resume it by passing its agent id as `resume` to the `Agent` tool) before spawning a new one.
- **Batch** when several tasks are individually too small to justify a spawn but sit in the
  same area. One agent, one cold start, one area load — the per-spawn cost that argues for
  inline amortizes across the batch and stops arguing. Batch only tasks at the **same tier**
  (one judgment trigger would drag the whole batch to `strong`) and in the **same module** (that
  is what makes one area load serve all of them). The agent commits each task separately and
  reports status, sha and Verify output **per task** — a batch that blocks on its second task
  must still be recordable as `DONE` / `BLOCKED` across two rows.
- **Inline** only when the work has no written brief and is small or tightly coupled to what
  you just did. "Cheaper to do than to explain" measures writing a brief that does not exist
  yet — a specified plan task *is* its brief, so the clause never fires on one. Cold start is
  a fixed cost per spawn, not a reason to inline written work.

When no single task justifies a spawn, batch the small ones rather than absorbing them
inline. Inline keeps the ledger row, the `git mv`, and the close.

## Step 4: Run the task

You hold the plan, so **you are the only writer of its ledger**. Never ask a subagent to
edit the plan file — parallel implementers collide on the same rows.

1. Mark the todo in_progress; set the ledger row to `WIP`
2. Dispatch per Step 3, or follow the plan's steps inline where Step 3 says inline
3. Run the task's **Verify** command. Code landed but not yet verified is `REVIEW`, not `DONE`
4. On a pass: flip the row to `DONE` with the code commit's sha and the actual output line
   as Evidence — never "tests pass" — in a ledger-only commit straight after that code
   commit. Inline, the row rides the code commit as `REVIEW`. A commit cannot carry its own
   sha; never amend to insert one, it mints a new sha
5. Blocked or descoped: `BLOCKED` / `DROPPED` with the reason in Evidence, then stop and ask
6. Mark the todo completed

**Reading a sub's report.** A sub that reports "tests pass" with no output line has not given
you Evidence — ask for the line, do not invent one. When a sub reports blocked:

| Cause | Response |
|---|---|
| Missing context | Supply it, re-dispatch at the same tier |
| Needs more reasoning | Re-dispatch one tier higher |
| Task too large | Split it |
| The plan itself is wrong | Escalate to your partner — do not patch around it |

Never re-dispatch the same task at the same tier with the same brief. If the sub is stuck,
something has to change.

**No `WIP` row survives the session.** Before you finish for any reason — done, blocked,
interrupted — every row reads its real state.

## Step 5: Close the run

After every task is verified, set **Plan status** to `COMPLETE` and move the file out of
`WIP/` in that same commit:

```bash
mkdir -p docs/plans/completed && git mv docs/plans/WIP/<plan>.md docs/plans/completed/<plan>.md
```

A run that ends unfinished does not move: it stays in `WIP/` as `IN PROGRESS` or `BLOCKED`,
or goes back to the base directory as `PARKED` if nobody will pick it up soon.

Delete any brief directory you cut — it is scratch, not an artifact.

Then use the `finishing-a-development-branch` skill to verify tests, present options, and
execute the choice.

## Stop and ask when

- You hit a blocker — missing dependency, failing test, unclear instruction
- The plan has critical gaps preventing a start
- Verification fails repeatedly

Ask rather than guess. Don't force through blockers.

Return to Step 1 when your partner updates the plan, or when the approach needs rethinking.

## Remember

- Review the plan critically first
- Decide dispatch per task, not per run
- Don't skip verifications
- Never start implementation on main/master without explicit consent
- Reference skills when the plan says to

## Related skills

| Skill | Owns | Used at |
|---|---|---|
| `plan-lifecycle` | Ledger, status enums, folders | Step 1 |
| `orchestration` | Slicing, briefs, model tiers, reviewers | Step 3 |
| `writing-plans` | Creates the plan this skill executes | Before |
| `using-git-worktrees` | Isolated workspace | Before |
| `finishing-a-development-branch` | Closes the branch | Step 5 |
