/**
 * PreToolUse gate for Bash commands that write to memory files or plan files.
 *
 * Memory files and plan ledgers are both governed by hooks that run on Write/Edit
 * (`memory-gate.js`) and at Stop (`memory-lint.js`, `plan-ledger-gate.js`). A shell
 * redirect, a heredoc, `sed -i` or a `cp`/`mv` walks straight past the Write/Edit gate:
 * the file changes, no PostToolUse hook sees a `file_path`, and the bad line lands.
 * Shell rewriting also mangles bodies — quoting, `$`, backticks — so the content that
 * arrives is not always the content that was intended.
 *
 * This hook closes that path. It reads `tool_input.command`, and refuses (exit 2, reason
 * on stderr) when a write construct targets a path under a `memory/` directory or under
 * `docs/plans/`. Reads are untouched: `ls`, `cat`, `sed -n`, `grep`, `head` and
 * `git mv|add|rm` on those paths all pass, because none of them is a shell-authored write.
 *
 * Windows and POSIX path forms both match — separators are normalised before the test.
 *
 * SEARCH TAGS: write path gate, PreToolUse Bash hook, heredoc block, sed -i block,
 *   redirect to memory, docs/plans write, shell write bypass
 */

const fs = require("fs");

// Path shapes whose contents are hook-governed and must be authored with Write/Edit.
const GUARDED_PATTERNS = [/(^|\/)memory\//i, /(^|\/)docs\/plans\//i];

// `git mv|add|rm` move and stage files; they never author content, so they are exempt.
const GIT_EXEMPT_SUBCOMMANDS = new Set(["mv", "add", "rm"]);

// Split a command line into the pieces that each have their own leading program.
const SEGMENT_SPLIT_RE = /(?:\|\||&&|[;|\n])/;

// `>` or `>>` followed by its target. `2>&1` and `>&2` match none of the alternatives,
// so file-descriptor duplication is not read as a redirect to a file.
const REDIRECT_RE = /(>>?)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
const HEREDOC_RE = /<<-?\s*(["']?)[A-Za-z_][A-Za-z0-9_]*\1/;
// `-i`, `-i.bak`, or `-i` bundled with other flags (`-ni`). `sed -n` must not match.
const SED_INPLACE_RE = /\bsed\b[^;|&\n]*?\s-[a-zA-Z]*i(?![a-zA-Z])/;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Strip surrounding quotes and normalise separators so `docs\plans\` reads as `docs/plans/`. */
function normalise(token) {
  return token.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
}

function isGuarded(token) {
  const p = normalise(token);
  return GUARDED_PATTERNS.some((re) => re.test(p));
}

/** Tokens of a segment, quotes preserved so a quoted path with spaces stays one token. */
function tokenise(segment) {
  return segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
}

/** Every guarded redirect target in the command, e.g. `>> .../memory/a.md`. */
function redirectTargets(command) {
  const hits = [];
  for (const m of command.matchAll(REDIRECT_RE)) {
    if (isGuarded(m[2])) hits.push({ op: `${m[1]} redirect`, target: normalise(m[2]) });
  }
  return hits;
}

/** Guarded arguments to `tee`, which writes every path it is given. */
function teeTargets(segment) {
  const tokens = tokenise(segment);
  const at = tokens.findIndex((t) => t === "tee" || t.endsWith("/tee"));
  if (at === -1) return [];
  return tokens
    .slice(at + 1)
    .filter((t) => !t.startsWith("-") && isGuarded(t))
    .map((t) => ({ op: "tee", target: normalise(t) }));
}

/** `cp`/`mv` writing into a guarded path — judged on the destination, the last operand. */
function copyMoveTarget(segment) {
  const tokens = tokenise(segment);
  if (!tokens.length) return null;
  const program = normalise(tokens[0]).split("/").pop();
  if (program !== "cp" && program !== "mv") return null;
  const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const dest = operands[operands.length - 1];
  if (!dest || !isGuarded(dest)) return null;
  return { op: program, target: normalise(dest) };
}

/** True when this segment is `git mv|add|rm` — a move or a stage, never authored content. */
function isGitExempt(segment) {
  const tokens = tokenise(segment);
  if (!tokens.length) return false;
  if (normalise(tokens[0]).split("/").pop() !== "git") return false;
  const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
  return sub !== undefined && GIT_EXEMPT_SUBCOMMANDS.has(sub);
}

function findViolations(command) {
  const violations = [];

  // A heredoc body spans the newlines a segment split would cut on, so it is judged on
  // the whole command: the delimiter and a guarded path together mean an authored write.
  if (HEREDOC_RE.test(command)) {
    const guardedToken = tokenise(command).find(isGuarded);
    if (guardedToken) {
      violations.push({ op: "heredoc", target: normalise(guardedToken) });
    }
  }

  for (const segment of command.split(SEGMENT_SPLIT_RE)) {
    if (!segment.trim() || isGitExempt(segment)) continue;

    violations.push(...redirectTargets(segment));
    violations.push(...teeTargets(segment));

    if (SED_INPLACE_RE.test(segment)) {
      const target = tokenise(segment).find(isGuarded);
      if (target) violations.push({ op: "sed -i", target: normalise(target) });
    }

    const cm = copyMoveTarget(segment);
    if (cm) violations.push(cm);
  }

  return violations;
}

const raw = readStdin();
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(0); // not our shape — fail open, another gate owns malformed input
}

const command = (input.tool_input && input.tool_input.command) || "";
if (!command) process.exit(0);

const violations = findViolations(command);
if (!violations.length) process.exit(0);

const seen = new Set();
const lines = [];
for (const v of violations) {
  const key = `${v.op}\u0000${v.target}`;
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push(`  - ${v.op} → ${v.target}`);
}

process.stderr.write(
  `Bash write refused — this command authors a memory or plan file through the shell:\n\n` +
    lines.join("\n") +
    `\n\nFiles under a \`memory/\` directory or \`docs/plans/\` must be written with the ` +
    `Write or Edit tool. Those tools fire the PostToolUse memory gate and give the Stop ` +
    `hooks a file to lint; a redirect, heredoc, \`sed -i\`, \`cp\` or \`mv\` bypasses both, ` +
    `and shell quoting mangles the body on the way in.\n\n` +
    `Re-issue this as a Write (whole file) or Edit (one exact replacement). Reading is ` +
    `unaffected — \`cat\`, \`sed -n\`, \`grep\`, \`ls\` and \`git mv|add|rm\` on these paths ` +
    `all pass. Nothing was executed.\n`
);
process.exit(2);
