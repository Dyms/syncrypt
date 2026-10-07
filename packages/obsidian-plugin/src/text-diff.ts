// Line diff for the compare view (RFC-0010). Pure: no `obsidian` import, no I/O,
// so it is tested without the app.
//
// A side is TEXT when it is valid UTF-8 with no NUL byte. Anything else, or
// anything past the limits below, is not diffed: the view then shows sizes and
// dates and says why. A wrong or hung diff is worse than none — this is what a
// person reads to decide whether to let a file be deleted.

export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_DIFF_LINES = 20_000;
/** Inserted + deleted lines the search will look for before giving up. */
export const MAX_DIFF_EDITS = 1_000;
export const CONTEXT_LINES = 3;

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based line numbers; absent on the side the line does not exist on. */
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  lines: DiffLine[];
}

export type TooLargeReason = "bytes" | "lines" | "edits";

export type DiffResult =
  | { kind: "identical" }
  /** Different bytes, same lines: line endings, a final newline, or a BOM. */
  | { kind: "format-only" }
  | { kind: "hunks"; hunks: Hunk[]; added: number; removed: number }
  | { kind: "binary" }
  | { kind: "too-large"; reason: TooLargeReason };

/** The text of `bytes`, or null when it is not text we would diff. */
export function decodeText(bytes: Uint8Array): string | null {
  for (const b of bytes) if (b === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop(); // a final newline is not a line
  return lines;
}

interface Step {
  kind: "same" | "add" | "del";
  text: string;
}

/** Myers' O(ND) shortest edit script; null when more than `maxD` edits are needed. */
function editScript(a: string[], b: string[], maxD: number): Step[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "add", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));
  const dmax = Math.min(n + m, maxD);
  const off = dmax + 1;
  const v = new Int32Array(2 * dmax + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= dmax; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))) x = v[off + k + 1] ?? 0;
      else x = (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], off: number): Step[] {
  const steps: Step[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? new Int32Array(0);
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? k + 1 : k - 1;
    const prevX = v[off + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push({ kind: "same", text: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) steps.push({ kind: "add", text: b[y - 1] ?? "" });
      else steps.push({ kind: "del", text: a[x - 1] ?? "" });
    }
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

function toHunks(steps: Step[]): Hunk[] {
  const numbered: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const s of steps) {
    if (s.kind === "same") numbered.push({ kind: "same", text: s.text, oldNo: ++oldNo, newNo: ++newNo });
    else if (s.kind === "del") numbered.push({ kind: "del", text: s.text, oldNo: ++oldNo });
    else numbered.push({ kind: "add", text: s.text, newNo: ++newNo });
  }
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < numbered.length) {
    if (numbered[i]?.kind === "same") {
      i++;
      continue;
    }
    // Grow a hunk: changes, with context before and after, merging changes
    // closer than twice the context.
    const start = Math.max(0, i - CONTEXT_LINES);
    let end = i;
    let lastChange = i;
    for (let j = i; j < numbered.length; j++) {
      if (numbered[j]?.kind !== "same") {
        lastChange = j;
        end = j;
      } else if (j - lastChange > 2 * CONTEXT_LINES) {
        break;
      }
    }
    const stop = Math.min(numbered.length, end + CONTEXT_LINES + 1);
    hunks.push({ lines: numbered.slice(start, stop) });
    i = stop;
  }
  return hunks;
}

/** Compare two versions. `null` is "absent" (no file on that side). */
export function compareBytes(left: Uint8Array | null, right: Uint8Array | null): DiffResult {
  if (left === null && right === null) return { kind: "identical" };
  if (left !== null && right !== null && left.length === right.length) {
    let same = true;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) {
        same = false;
        break;
      }
    }
    if (same) return { kind: "identical" };
  }
  if ((left?.length ?? 0) > MAX_DIFF_BYTES || (right?.length ?? 0) > MAX_DIFF_BYTES) {
    return { kind: "too-large", reason: "bytes" };
  }
  const a = left === null ? "" : decodeText(left);
  const b = right === null ? "" : decodeText(right);
  if (a === null || b === null) return { kind: "binary" };
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  if (aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES) {
    return { kind: "too-large", reason: "lines" };
  }
  // Common head and tail first: a note edited in one place is mostly that.
  let head = 0;
  while (head < aLines.length && head < bLines.length && aLines[head] === bLines[head]) head++;
  let tail = 0;
  while (
    tail < aLines.length - head &&
    tail < bLines.length - head &&
    aLines[aLines.length - 1 - tail] === bLines[bLines.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = aLines.slice(head, aLines.length - tail);
  const midB = bLines.slice(head, bLines.length - tail);
  if (midA.length === 0 && midB.length === 0) return { kind: "format-only" };
  const script = editScript(midA, midB, MAX_DIFF_EDITS);
  if (script === null) return { kind: "too-large", reason: "edits" };
  const steps: Step[] = [
    ...aLines.slice(0, head).map((text): Step => ({ kind: "same", text })),
    ...script,
    ...aLines.slice(aLines.length - tail).map((text): Step => ({ kind: "same", text })),
  ];
  const hunks = toHunks(steps);
  return {
    kind: "hunks",
    hunks,
    added: steps.filter((s) => s.kind === "add").length,
    removed: steps.filter((s) => s.kind === "del").length,
  };
}
