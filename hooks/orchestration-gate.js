/**
 * UserPromptSubmit gate for the orchestration skill.
 *
 * A hook cannot judge whether a plan is "complex" — it can only measure. The proxy that
 * actually predicts cost is document size, which is the same threshold the rule uses:
 * a subagent re-ingests whatever it is pointed at, so a big file is what makes slicing pay.
 *
 * Fires only when the prompt names a file that exists and is >= THRESHOLD lines.
 * Prints nothing otherwise, so simple plans cost zero tokens.
 *
 * Path shapes that must resolve, because each occurs in real prompts on a Windows box
 * whose home directory contains a space:
 *   docs/plan.md                cwd-relative
 *   ~/.claude/DEV_RULES.md      tilde home — path.resolve does NOT expand this
 *   C:/Users/Jane Doe/x.md     absolute, drive letter, embedded space
 *   "docs/my plan.md"           quoted
 * A miss is silent by design, which makes an over-narrow match indistinguishable from
 * "the file was small" — hence the suffix walk below rather than one strict token match.
 *
 * SEARCH TAGS: orchestration hook, plan size gate, UserPromptSubmit, tilde expansion
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const THRESHOLD = 300;
const MAX_CANDIDATES = 40;
// Bound on leading words trimmed per match. A path with more spaces than this is past
// the point where guessing beats staying quiet, and the hook has a 5s timeout.
const MAX_SUFFIX_ATTEMPTS = 8;

// Two passes, because one regex cannot serve both shapes. STRICT_RE forbids spaces, so
// "compare a.md with b.md" yields two tokens rather than one. LOOSE_RE permits interior
// spaces to reach "Jane Doe/x.md", but for that same reason it merges neighbouring paths
// into a single token — it runs second and only contributes what STRICT_RE could not
// resolve. Dedupe on the resolved path reconciles the overlap.
const STRICT_RE = /[\w.:@~/\\-]+\.(?:md|markdown|txt|rst)\b/gi;
const LOOSE_RE = /[\w.:@~/\\-][\w.:@~/\\ -]*\.(?:md|markdown|txt|rst)\b/gi;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Strip prompt punctuation that clings to a path but is never part of it. */
function clean(token) {
  return token
    .replace(/\\/g, "/")
    .replace(/^[`'"(<[]+/, "")
    .replace(/[`'")>\],.;:]+$/, "")
    .replace(/^@/, "");
}

/** Expand a leading ~ to the real home directory; path.resolve treats it as a literal. */
function expandHome(candidate) {
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/")) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

/**
 * Every plausible start point for a path, longest first: the whole match, then the same
 * string with leading space-separated words dropped. "read C:/Users/Jane Doe/x.md"
 * yields the full string, then "C:/Users/Jane Doe/x.md", and the second one resolves.
 */
function suffixCandidates(token) {
  const parts = token.split(" ");
  const out = [];
  for (let i = 0; i < parts.length && i < MAX_SUFFIX_ATTEMPTS; i++) {
    const suffix = parts.slice(i).join(" ").trim();
    if (suffix) out.push(suffix);
  }
  return out;
}

/** Resolved path and line count if this is a file at or over THRESHOLD, else null. */
function measure(candidate) {
  try {
    const resolved = path.resolve(expandHome(candidate));
    if (!fs.statSync(resolved).isFile()) return null;
    const lines = fs.readFileSync(resolved, "utf8").split("\n").length;
    return lines >= THRESHOLD ? { resolved, lines } : null;
  } catch {
    // Not a real path, or unreadable. Silence is the correct behaviour.
    return null;
  }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0);

let prompt = "";
try {
  const parsed = JSON.parse(raw);
  prompt = parsed.prompt || "";
  if (Array.isArray(prompt)) prompt = prompt.map((p) => (p && p.text) || "").join(" ");
  if (typeof prompt !== "string") prompt = String(prompt);
} catch {
  process.exit(0);
}
if (!prompt) process.exit(0);

const seenResolved = new Set();
const large = [];

function scan(regex) {
  const tokens = prompt.match(regex) || [];
  for (const token of tokens.slice(0, MAX_CANDIDATES)) {
    for (const candidate of suffixCandidates(clean(token))) {
      const hit = measure(candidate);
      if (!hit) continue;
      // Dedupe on the resolved path: docs/x.md and ./docs/x.md are one document.
      if (!seenResolved.has(hit.resolved)) {
        seenResolved.add(hit.resolved);
        large.push(`${candidate} (${hit.lines} lines)`);
      }
      break; // Longest resolving suffix wins; shorter ones are fragments of it.
    }
  }
}

scan(STRICT_RE);
scan(LOOSE_RE);

if (!large.length) process.exit(0);

process.stdout.write(
  `Plan-sized document referenced: ${large.join(", ")}. ` +
    `If any part of this task will be handed to a subagent, invoke the orchestration ` +
    `skill BEFORE writing the first brief — slice by line range and pass the slice path, ` +
    `never point a subagent at the whole file. Ignore this if no subagents are involved.`
);
