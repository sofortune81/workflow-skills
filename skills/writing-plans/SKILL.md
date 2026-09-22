---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree (created by brainstorming skill).

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)
- Not `docs/superpowers/plans/` — that name is specific to one tool's plugin, and these
  plans are read by every AI tool working the repo.

**A new plan is written to the base plan directory, never into a lifecycle folder.** The
plan directory has three states and the file moves between them with `git mv` as its status
changes — base = idle (`PLANNED`, `PARKED`), `WIP/` = active (`IN PROGRESS`, `BLOCKED`),
`completed/` = closed (`COMPLETE`, `DROPPED`). A plan you are writing is `PLANNED`, so it
belongs in the base directory. Moving it is the executor's job, not yours.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The Ledger below is the only status record — rules in the `plan-lifecycle` skill and in docs/plans/README.md.

**Plan status:** PLANNED · 0/[N] done · branch `[branch]` · updated [YYYY-MM-DD]
**Resume at:** Task 1

## Ledger

| # | Task | Status | Commit | Evidence |
|---|---|---|---|---|
| 1 | [Task 1 name] | TODO | — | — |
| 2 | [Task 2 name] | TODO | — | — |
| N | [Task N name] | TODO | — | — |

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

**Seed the ledger here, at write time** — one row per task, every status `TODO`, names
matching the `### Task N:` headings exactly. A ledger added during execution has no
baseline: a row written late cannot be told from a task that was never planned, and the row
count written here is the scope contract. The ledger sits above the preamble so slicing the
preamble into subagent briefs does not drag status into every brief.

## Tier per task

Plans name harness-neutral tiers, never models — the executing harness maps each tier to its
own model in `~/.kimi-code/TIERS.md`.

| Task shape | Tier |
|---|---|
| Transcription-grade — plan specifies the code, mechanical edit, no design decision left | `standard` |
| Any judgment trigger — state machines, a11y/focus, security-adjacent, unverified deletions, spec contradictions | `strong` |
| Failure is silent, touches anything live, or cannot be reverted by discarding one file | `max` |
| Run, search, extract, verify — not deciding | `fast` |
| Review of a task | never below the tier that wrote it |

Seed this table in the plan, one row per task, directly under the Ledger:

```markdown
| Task | Tier | Why |
|---|---|---|
| 1 | standard | code fully specified in the step blocks |
| 2 | strong | resolves a spec contradiction in the state machine |
```

The orchestrator may overturn a row at dispatch with one line of rationale in that task's
ledger Evidence.

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Verify:** `pytest tests/exact/path/to/test.py -q` → all pass

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit the code with this task's ledger row at REVIEW**

Row becomes: `| N | [Task name] | REVIEW | — | — |`

```bash
git add tests/path/test.py src/path/file.py docs/plans/<this-plan>.md
git commit -m "feat: add specific feature"
```

- [ ] **Step 6: Flip the row to DONE in a ledger-only commit**

Row becomes: `| N | [Task name] | DONE | <sha of the Step 5 commit> | <the Verify output line> |`

```bash
git add docs/plans/<this-plan>.md
git commit -m "docs(plans): <plan> Task N done"
```
````

**The sha rides the next commit, never its own.** A commit cannot contain its own sha, and
amending to insert one mints a new sha — so the code commit carries the row as `REVIEW` and
the ledger-only commit straight after records the real sha. Never batch the flips to the end.

**Every task carries a Verify line.** It is the command that moves that task's row from
`REVIEW` to `DONE`; without it the transition is unfalsifiable. Name the exact command and
its expected output, never "run the tests".

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Ledger seeding:** One ledger row per `### Task N:` heading, same count, same names, every status `TODO`. Every task has a Verify line. A plan that ships with a short or missing ledger cannot be repaired later.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving the plan, hand off to the runner:

**"Plan complete and saved to `docs/plans/<filename>.md`. Ready to execute?"**

- **REQUIRED SUB-SKILL:** Use `executing-plans`

It opens the run, then decides per task whether to dispatch or implement inline — that fork
lives inside the runner, so it is not a question to ask here. Where the plan carries a
per-task tier suggestion table, the runner treats it as an input via the
`orchestration` skill, not as binding.
