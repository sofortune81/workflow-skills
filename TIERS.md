# Tiers — Kimi Code mapping

Skills and plans name harness-neutral tiers. This file maps them to this harness and is the
only file here that names models. The sync inlines it into `AGENTS.md`, so it is loaded every
session. Claude's counterpart is `~/.claude/TIERS.md`.

| Tier | Model | Pool key |
|---|---|---|
| `fast` | K2.7 Code Highspeed | `kimi-code/kimi-for-coding-highspeed` |
| `standard` | K2.8 Preview | `kimi-code/kimi-for-coding` |
| `strong` | K3 | `kimi-code/k3` |
| `max` | K3 at effort `max` | `k3-max` |

The pool key is what the Agent tool's `model` parameter takes — kimi dispatches by config
key, not by model name. `max` is its own key because kimi binds thinking effort to the config
entry rather than to the dispatch; add an effort point by registering a variant in
`config.toml` (the `[models.k3-max]` pattern) and listing it in the `[secondary_model]` pool.

Plans written before tiers name Claude models directly: haiku = `fast`, sonnet = `standard`,
opus = `strong`.

## Applying a tier

- Pass the pool key as the Agent tool's `model` parameter on every dispatch. A dispatch with
  no `model` lands on the pool default, `standard`.
- Agent files carry no working model field — the sync strips Claude Code's `model:` /
  `effort:` frontmatter, so a standing agent has no default tier here.
