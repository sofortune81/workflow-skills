# Workflow skills

The plan-driven, tier-dispatched subagent workflow, packaged as a self-contained drop-in.
The layout mirrors a harness user-scope directory (`~/.kimi-code/` for Kimi Code,
`~/.claude/` for Claude Code): copy `skills/`, `agents/` and `TIERS.md` into place and the
workflow is live.

## The four pillars

**1. Plan lifecycle** (`skills/plan-lifecycle/`)
Plans are files, not chat. A plan lives in `<plans>/` when idle, `<plans>/WIP/` while a run
is open, and `<plans>/completed/` when closed. The ledger table at the top of the plan is
the only status record — no prose, no memory files. Includes `templates/plans-README.md`
(the status enums and rules a repo adopts) and `scripts/init-plans.js` to bootstrap the
structure in a repo that has none.

**2. Agent front-matter categorization** (`agents/` + `TIERS.md`)
Standing agents are markdown files with `name:` / `description:` front matter and nothing
else — no model field. The tier (`fast` / `standard` / `strong` / `max`) is assigned at
dispatch time by the orchestrator, per `TIERS.md`, which maps each tier to a concrete
model pool key per harness. Plans and skills name tiers, never models, so the same plan
runs on any harness. Reviewer tier is never below implementer tier.

| Agent | Role |
|---|---|
| `impl` | Implements one task from a written brief; brief is its whole context |
| `verify` | Runs given build/test/lint commands; reports pass/fail plus failing cases only |
| `diff-review` | Reviews a git diff against acceptance criteria; reports defects only |
| `security-reviewer` | Reviews a change for security defects before merge |

**3. Orchestration** (`skills/orchestration/`)
The dispatch rules: which tier each task type gets, how briefs are cut (slice-by-line-range,
never "read the whole plan"), diff-only review, read caps, and the return contract — the
conclusion, never the transcript.

**4. Execution** (`skills/executing-plans/`, `skills/writing-plans/`)
`writing-plans` turns a spec into a multi-step plan file; `executing-plans` runs one task
by task — open the run, decide per task whether to dispatch a subagent or implement inline,
keep the ledger, close the run, and move the plan between folders as its status changes.

## Enforcement hooks

The skills describe the rules; the hooks in `hooks/` are what make them hold every time.
All three are plain Node (no dependencies), fail open on malformed input, and print
nothing when they have nothing to say.

| Hook | Event | Enforces |
|---|---|---|
| `plan-ledger-gate.js` | `Stop` | Plan lifecycle: no `WIP` row survives a session, no evidence-less `DONE`, folder matches status |
| `orchestration-gate.js` | `UserPromptSubmit` | Reminds the orchestration rules when a prompt names a file ≥300 lines — the size at which slicing pays |
| `write-path-gate.js` | `PreToolUse` on `Bash` | Closes the shell bypass: redirects, heredocs, `sed -i` and `cp`/`mv` aimed at `docs/plans/` (or `memory/`) are refused — those files are authored with Write/Edit so the other gates see them |

## Install

```bash
# Kimi Code (Claude Code uses the same layout under ~/.claude/)
cp -r skills/* ~/.kimi-code/skills/
cp agents/*.md ~/.kimi-code/agents/
cp hooks/*.js ~/.kimi-code/hooks/
cp TIERS.md ~/.kimi-code/
```

Register the hooks in `config.toml` (Kimi Code) or `settings.json` (Claude Code — same
event names):

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/write-path-gate.js"
timeout = 5

[[hooks]]
event = "UserPromptSubmit"
command = "node ~/.kimi-code/hooks/orchestration-gate.js"
timeout = 5

[[hooks]]
event = "Stop"
command = "node ~/.kimi-code/hooks/plan-ledger-gate.js"
timeout = 10
```

After copying, reference the tiers from your global rules (dispatch table: which task gets
which tier) so every subagent dispatch passes an explicit `model` — a dispatch with no
tier lands on the harness default, which is rarely what a review step wants.
