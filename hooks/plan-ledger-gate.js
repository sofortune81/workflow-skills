/**
 * Stop gate for plan ledgers.
 *
 * A rule in DEV_RULES.md is advisory — the model may or may not act on it. This hook is
 * the deterministic half: it reads the ledger table at the top of every in-flight plan and
 * refuses to let the session end while the ledger is lying about the state of the work.
 *
 * The four lies it can prove from the file alone:
 *   WIP at stop time      — WIP means "dispatched, in flight". Nothing is in flight once
 *                           the session ends, so the row is stale by definition.
 *   DONE with no evidence — DONE is a verification claim. A claim with an empty Commit or
 *                           Evidence cell is unfalsifiable, which is the false-green trap
 *                           this repo already has with RTK summaries.
 *   BLOCKED/DROPPED bare  — a task removed from the run without a recorded reason is
 *                           indistinguishable from one that was forgotten.
 *   Wrong folder          — plan status and lifecycle folder are two records of one fact.
 *                           Enforcing the mapping is what stops them drifting apart.
 *
 * It never moves a file. A hook that renames mid-session leaves the model editing a path
 * that no longer exists, and the rename has to land in git anyway — so it prints the
 * `git mv` and lets the session run it.
 *
 * Scoped to the plans this session's transcript (or a subagent's) names, because several
 * sessions share one working tree and a foreign session's WIP row is not this session's
 * lie to fix.
 *
 * Silent unless a violation is found, so plan-free sessions cost nothing. A plan whose own
 * status is terminal is skipped for row checks — finished plans must not nag forever — but
 * still location-checked, since a COMPLETE plan sitting in WIP/ is the thing this prevents.
 *
 * SEARCH TAGS: plan ledger, Stop hook, plan status, task status enum, stale WIP, plan folder
 */

const fs = require("fs");
const path = require("path");
const { verdict } = require("./stop-refire.js");

// Content-gated, not path-gated: a file counts as a plan only if it carries MARKER, so
// adding a directory here cannot produce false positives on ordinary docs.
const PLAN_DIRS = ["docs/plans", "docs/superpowers/plans", "plans"];
const MARKER = "**Plan status:**";
const WAITING_MARKER = "**Waiting on:**";
// Plan statuses that mean somebody is on the plan right now, so the preamble has to say who.
const HOLDER_REQUIRED = new Set(["IN PROGRESS", "BLOCKED"]);
// Documentation living in a plans directory. It quotes the marker in its examples, so
// content-gating alone would read it as a plan.
const NOT_PLANS = new Set(["readme.md", "index.md", "contributing.md"]);
// Runaway backstop only. It must stay unreachable in normal use, because completed/ grows
// without bound — one more file per finished plan, forever — and a cap that the archive
// eventually crosses stops being a backstop and becomes a wall that blocks every stop. The
// mtime window below is what actually keeps the working set flat; this is the last resort.
// An earlier cap of 80 was already smaller than one repo's archive and silently stopped
// scanning part-way, which reads exactly like "nothing is wrong". Hitting it is reported.
const MAX_FILES = 2000;
// A terminal plan sitting in completed/ returns before its ledger is parsed, so reading one
// can only ever find one thing: a plan in completed/ whose status is NOT terminal. That
// arises when someone reopens a finished plan by editing its status line and forgets to
// move it back — an edit, which refreshes mtime. One day is therefore as effective as a
// month, and keeps the working set to the plans actually finished today. Cheap `stat`, no
// read; archive size stops mattering.
const ARCHIVE_RECHECK_DAYS = 1;
// The status line and ledger sit at the top of a plan by rule, so the rest of the file is
// never needed. A ledger that runs past this is reported rather than half-checked.
const HEAD_BYTES = 16_384;
const MAX_REPORTED = 12;

const WIP_DIR = "WIP";
const DONE_DIR = "completed";
// Lifecycle folder per plan status. "" is the base directory itself — the idle queue, which
// holds both plans not yet started and plans parked for later.
const STATUS_FOLDER = {
  PLANNED: "",
  PARKED: "",
  "IN PROGRESS": WIP_DIR,
  BLOCKED: WIP_DIR,
  COMPLETE: DONE_DIR,
  DROPPED: DONE_DIR,
};
const LIFECYCLE_DIRS = new Map([
  [WIP_DIR.toLowerCase(), WIP_DIR],
  [DONE_DIR.toLowerCase(), DONE_DIR],
]);

const ROW_STATUSES = new Set(["TODO", "WIP", "REVIEW", "DONE", "BLOCKED", "DROPPED"]);
const PLAN_STATUSES = new Set(Object.keys(STATUS_FOLDER));
// Terminal at the plan level: stop checking rows, the run is over.
const PLAN_TERMINAL = new Set(["COMPLETE", "PARKED", "DROPPED"]);
// Every spelling of "nothing here". A ledger cell holding one of these is empty.
const EMPTY_CELL = new Set(["", "-", "--", "—", "–", "n/a", "na", "tbd", "?", "none", "todo"]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** First HEAD_BYTES of a file, plus whether the file continues past that point. */
function readHead(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const truncated = read === HEAD_BYTES;
    let text = buf.subarray(0, read).toString("utf8");
    // Drop the final partial line, or it parses as a ledger row with an empty status cell
    // and reports a defect that only exists at the byte boundary.
    // Exclusive of the newline: keeping it leaves a trailing empty line, which parses as
    // "not a table row" and ends the row loop as though the ledger had finished.
    if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
    return { text, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

/** Markdown table row -> trimmed cells, or null if the line is not a row. */
function parseCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isEmptyCell(value) {
  return EMPTY_CELL.has(value.toLowerCase());
}

/**
 * Locate the ledger by its header row rather than by the "## Ledger" heading: the heading
 * is prose and drifts, the column names are the contract. Indices are resolved by name so
 * a reordered table still parses.
 */
function findLedgerHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCells(lines[i]);
    if (!cells || cells.length < 3) continue;
    const lower = cells.map((cell) => cell.toLowerCase());
    const status = lower.indexOf("status");
    if (status === -1) continue;
    return {
      index: i,
      status,
      id: lower.indexOf("#"),
      task: lower.indexOf("task"),
      commit: lower.indexOf("commit"),
      evidence: lower.indexOf("evidence"),
    };
  }
  return null;
}

/**
 * Plan-level preamble: status word (upper-cased), the `holder:` field, and whether a
 * `**Waiting on:**` line follows within the preamble block. Fields are matched by shape so
 * a reordered preamble still parses.
 */
function planPreamble(lines) {
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(MARKER);
    if (at === -1) continue;
    const rest = lines[i].slice(at + MARKER.length).trim();
    const parts = rest.split("·").map((p) => p.trim());
    const status = parts[0].toUpperCase() || null;
    let holder = null;
    for (const part of parts.slice(1)) {
      const m = part.match(/^holder:\s*(.+)$/i);
      if (m) holder = m[1].trim();
    }
    // Preamble-scoped: the marker also appears in plan prose and in this hook's own docs.
    let waitingOn = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const line = lines[j].trim();
      if (!line.startsWith(WAITING_MARKER)) continue;
      waitingOn = line.slice(WAITING_MARKER.length).trim() || null;
      break;
    }
    return { status, holder, waitingOn };
  }
  return { status: null, holder: null, waitingOn: null };
}

/** The `git mv` that puts this plan in the folder its status calls for. */
function moveCommand(file, wantSub) {
  const target = wantSub ? `${file.baseDir}/${wantSub}` : file.baseDir;
  const prefix = wantSub ? `mkdir -p "${target}" && ` : "";
  return `${prefix}git mv "${file.rel}" "${target}/${file.name}"`;
}

function checkPlan(file, text, truncated) {
  const lines = text.split("\n");
  const problems = [];

  const { status, holder, waitingOn } = planPreamble(lines);
  if (!status) return problems;

  if (!PLAN_STATUSES.has(status)) {
    problems.push(
      `${file.rel} — plan status "${status}" is not one of ${[...PLAN_STATUSES].join(", ")}`
    );
    return problems; // Unknown status: the folder it belongs in is undefined too.
  }

  const wantSub = STATUS_FOLDER[status];
  if (file.sub !== wantSub) {
    const here = file.sub ? `${file.baseDir}/${file.sub}/` : `${file.baseDir}/`;
    const want = wantSub ? `${file.baseDir}/${wantSub}/` : `${file.baseDir}/`;
    problems.push(
      `${file.rel} — status ${status} belongs in ${want} but the file is in ${here}  →  ${moveCommand(file, wantSub)}`
    );
  }

  // Who is on it, and — when nothing can move without someone else — who owes what. An
  // active plan with no holder is the row nobody can tell is abandoned.
  if (HOLDER_REQUIRED.has(status) && !holder) {
    problems.push(
      `${file.rel} — status ${status} with no holder. Add \`· holder: worktree \`<dir name>\`\` or \`· holder: owner\` to the Plan status line.`
    );
  }
  if (status === "BLOCKED" && !waitingOn) {
    problems.push(
      `${file.rel} — BLOCKED with no "${WAITING_MARKER} owner — <what>" line under the Plan status line. Name who owes what.`
    );
  }

  if (PLAN_TERMINAL.has(status)) return problems;

  const header = findLedgerHeader(lines);
  if (!header) {
    problems.push(`${file.rel} — has a Plan status line but no ledger table (needs a Status column)`);
    return problems;
  }

  let open = 0;
  let rows = 0;
  // True if the loop exhausted the lines it had rather than reaching the end of the table.
  // Harmless on a whole file; on a truncated read it means rows went unchecked.
  let ranOutOfLines = true;

  for (let i = header.index + 1; i < lines.length; i++) {
    const cells = parseCells(lines[i]);
    if (!cells) {
      ranOutOfLines = false; // table ended
      break;
    }
    if (isSeparatorRow(cells)) continue;
    rows++;

    const rowStatus = (cells[header.status] || "").toUpperCase();
    const id =
      (header.id !== -1 && cells[header.id]) ||
      (header.task !== -1 && cells[header.task]) ||
      `row ${rows}`;
    const where = `${file.rel} task ${id}`;

    if (!ROW_STATUSES.has(rowStatus)) {
      problems.push(`${where} — status "${cells[header.status] || ""}" is not one of ${[...ROW_STATUSES].join(", ")}`);
      continue;
    }

    if (rowStatus === "WIP") {
      problems.push(`${where} — still WIP at session end. Nothing is in flight now: set DONE, REVIEW, BLOCKED or TODO.`);
    }

    if (rowStatus === "DONE") {
      if (header.commit === -1 || isEmptyCell(cells[header.commit] || "")) {
        problems.push(`${where} — DONE with no Commit. Record the sha, or "uncommitted @ <branch>".`);
      }
      if (header.evidence === -1 || isEmptyCell(cells[header.evidence] || "")) {
        problems.push(`${where} — DONE with no Evidence. Paste the verification output line, not "tests pass".`);
      }
    }

    if ((rowStatus === "BLOCKED" || rowStatus === "DROPPED") && (header.evidence === -1 || isEmptyCell(cells[header.evidence] || ""))) {
      problems.push(`${where} — ${rowStatus} with no reason in Evidence.`);
    }

    if (rowStatus !== "DONE" && rowStatus !== "DROPPED") open++;
  }

  if (ranOutOfLines && truncated) {
    problems.push(
      `${file.rel} — ledger runs past the first ${HEAD_BYTES} bytes, so later rows were NOT checked. The ledger belongs at the top of the plan, above the preamble.`
    );
  }

  if (rows > 0 && open === 0 && status !== "COMPLETE") {
    // Only name the move when the file is not already there, or the command reads as a
    // rename of a path onto itself.
    const move = file.sub === DONE_DIR ? "" : ` and move it: ${moveCommand(file, DONE_DIR)}`;
    problems.push(
      `${file.rel} — every task is DONE or DROPPED but plan status is ${status}. Set it to COMPLETE${move}`
    );
  }

  return problems;
}

/** Markdown files in each plan directory and in its WIP/ and completed/ children only. */
function collectPlanFiles(root) {
  const found = [];
  let archivedSkipped = 0;
  const staleBefore = Date.now() - ARCHIVE_RECHECK_DAYS * 86_400_000;

  const addFrom = (baseDir, sub) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, baseDir, sub), { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return [];
      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !NOT_PLANS.has(entry.name.toLowerCase())
      ) {
        const abs = path.join(root, baseDir, sub, entry.name);
        if (sub === DONE_DIR) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(abs).mtimeMs;
          } catch {
            continue;
          }
          if (mtimeMs < staleBefore) {
            archivedSkipped++;
            continue;
          }
        }
        const rel = sub ? `${baseDir}/${sub}/${entry.name}` : `${baseDir}/${entry.name}`;
        found.push({ abs, rel, baseDir, sub, name: entry.name });
      }
    }
    return entries;
  };

  for (const baseDir of PLAN_DIRS) {
    const entries = addFrom(baseDir, "");
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Only the two lifecycle folders are descended into — an unrelated subdirectory of
      // plans/ is not a plan location and must not be swept in.
      const canonical = LIFECYCLE_DIRS.get(entry.name.toLowerCase());
      if (canonical) addFrom(baseDir, entry.name);
    }
  }

  return { files: found, archivedSkipped };
}

/**
 * Keep only the plans this session has touched.
 *
 * Several sessions share one working tree. Gating every plan in the repo at every
 * session's turn end means session A's honest `WIP` row blocks session B's stop, and B
 * — which cannot see A's dispatch — rewrites A's row to get past the gate.
 *
 * A plan is "this session's" only when the transcript (or a subagent's) shows an
 * Edit/Write/MultiEdit whose `file_path` resolves to that plan, or a Bash `git mv`/`git add`
 * naming it. Matching the filename anywhere in the transcript text was far too wide: an `ls`
 * of the WIP directory, a grep hit, or a quoted STATUS.md table claimed every plan in the
 * repo — which is the same all-plans gate this filter exists to avoid.
 *
 * If no transcript can be read the filter is skipped and every plan is checked, as before.
 */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);
const normalizePath = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p);

/** Recursively collect every tool_use block in a parsed transcript entry. */
function collectToolUses(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolUses(item, out);
    return;
  }
  if (node.type === "tool_use" && node.input && typeof node.input === "object") out.push(node);
  for (const key of ["message", "content", "toolUseResult"]) {
    if (node[key]) collectToolUses(node[key], out);
  }
}

function ownedBySession(input, files, root) {
  const transcript = input.transcript_path;
  if (!transcript || !files.length) return files;

  const sources = [transcript];
  const subDir = path.join(
    path.dirname(transcript),
    path.basename(transcript, path.extname(transcript)),
    "subagents"
  );
  try {
    for (const entry of fs.readdirSync(subDir)) {
      if (entry.endsWith(".jsonl")) sources.push(path.join(subDir, entry));
    }
  } catch {
    /* no subagent transcripts */
  }

  // Absolute paths an Edit/Write actually wrote, and the git mv/git add command strings.
  const written = new Set();
  const gitCommands = [];
  let readAny = false;

  for (const source of sources) {
    let raw;
    try {
      raw = fs.readFileSync(source, "utf8");
    } catch {
      continue;
    }
    readAny = true;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const uses = [];
      collectToolUses(entry, uses);
      for (const use of uses) {
        const target = use.input.file_path || use.input.notebook_path || use.input.path;
        if (EDIT_TOOLS.has(use.name) && typeof target === "string") {
          written.add(normalizePath(path.resolve(root, target)));
          continue;
        }
        // A plan moved with `git mv` or staged with `git add` is this session's too — the
        // lifecycle move is the one plan edit that is not a file write.
        if (typeof use.input.command === "string" && /\bgit\s+(mv|add)\b/.test(use.input.command)) {
          gitCommands.push(use.input.command);
        }
      }
    }
  }

  // No readable transcript: fall back to checking everything, as before.
  if (!readAny) return files;

  return files.filter(
    (file) =>
      written.has(normalizePath(path.resolve(root, file.abs))) ||
      gitCommands.some((cmd) => cmd.includes(file.rel) || cmd.includes(file.name))
  );
}

const raw = readStdin();
let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

// A plan the model cannot fix must not block every stop attempt forever — but a plan it
// simply did not fix must not sail through on the second try either. The re-fire decision
// therefore needs the problem set, and is taken below, once the plans have been read.
const root = input.cwd || process.cwd();
const problems = [];
const scan = collectPlanFiles(root);
scan.files = ownedBySession(input, scan.files, root);

// A truncated scan looks identical to a clean one. Say so rather than pass silently.
if (scan.files.length >= MAX_FILES) {
  problems.push(
    `plan scan stopped at ${MAX_FILES} files — plans past that point were NOT checked. Raise MAX_FILES in this hook.`
  );
}

for (const file of scan.files) {
  let head;
  try {
    head = readHead(file.abs);
  } catch {
    continue;
  }
  if (!head.text.includes(MARKER)) continue;
  problems.push(...checkPlan(file, head.text, head.truncated));
}

// Bounded re-fire: refuse again while the same rows are still wrong, concede after a few.
const call = verdict({ input, gate: "plan-ledger", problems });
if (!call.block) {
  if (call.note) process.stdout.write(call.note + "\n");
  process.exit(0);
}

const shown = problems.slice(0, MAX_REPORTED);
const extra = problems.length - shown.length;

process.stderr.write(
  `Plan ledger is out of date — fix the rows below before finishing.\n\n` +
    shown.map((p) => `  - ${p}`).join("\n") +
    (extra > 0 ? `\n  - ...and ${extra} more` : "") +
    (scan.archivedSkipped
      ? `\n\n(${scan.archivedSkipped} plan(s) in ${DONE_DIR}/ untouched for over ${ARCHIVE_RECHECK_DAYS} day${ARCHIVE_RECHECK_DAYS === 1 ? "" : "s"} were not re-read.)`
      : "") +
    `\n\nThe ledger at the top of the plan is the only status record; the folder is its index. ` +
    `Task statuses: TODO, WIP, REVIEW, DONE, BLOCKED, DROPPED. ` +
    `DONE requires a Commit and an Evidence line. ` +
    `Plans live in <plans>/ when idle (PLANNED, PARKED), <plans>/${WIP_DIR}/ when active (IN PROGRESS, BLOCKED), ` +
    `<plans>/${DONE_DIR}/ when closed (COMPLETE, DROPPED). ` +
    `If the work is genuinely unfinished, that is fine — record it as TODO or BLOCKED with a reason.\n` +
    (call.note ? `\n${call.note}\n` : "")
);
process.exit(2);
