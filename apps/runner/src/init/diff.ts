/**
 * A unified diff of one file (`git diff` style, 3 lines of context). `before` is undefined for a
 * new file. Line-based longest common subsequence: `init`'s files are small.
 */
export function unifiedDiff(path: string, before: string | undefined, after: string): string {
  const a = before === undefined ? [] : splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const header =
    before === undefined ? `--- /dev/null\n+++ b/${path}\n` : `--- a/${path}\n+++ b/${path}\n`;
  const hunks: string[] = [];
  const CONTEXT = 3;
  let i = 0;
  while (i < ops.length) {
    // The next change.
    while (i < ops.length && ops[i]!.kind === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while changes are within 2 * CONTEXT of each other.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.kind !== " ") end = j;
      else if (j - end > 2 * CONTEXT) break;
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const slice = ops.slice(start, stop);
    const aStart = ops.slice(0, start).filter((o) => o.kind !== "+").length;
    const bStart = ops.slice(0, start).filter((o) => o.kind !== "-").length;
    const aLen = slice.filter((o) => o.kind !== "+").length;
    const bLen = slice.filter((o) => o.kind !== "-").length;
    hunks.push(
      `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n` +
        slice.map((o) => `${o.kind}${o.line}\n`).join(""),
    );
    i = stop;
  }
  return hunks.length ? header + hunks.join("") : "";
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

interface Op {
  kind: " " | "-" | "+";
  line: string;
}

function diffLines(a: string[], b: string[]): Op[] {
  // Common prefix and suffix first, so the table covers only the changed middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const middle: Op[] = [];
  if (am.length * bm.length > 4_000_000) {
    // Too big to align: show it as replaced.
    middle.push(...am.map((line) => ({ kind: "-" as const, line })));
    middle.push(...bm.map((line) => ({ kind: "+" as const, line })));
  } else {
    const n = am.length;
    const m = bm.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--)
      for (let y = m - 1; y >= 0; y--)
        table[x]![y] =
          am[x] === bm[y]
            ? table[x + 1]![y + 1]! + 1
            : Math.max(table[x + 1]![y]!, table[x]![y + 1]!);
    let x = 0;
    let y = 0;
    while (x < n || y < m) {
      if (x < n && y < m && am[x] === bm[y]) {
        middle.push({ kind: " ", line: am[x]! });
        x++;
        y++;
      } else if (x < n && (y >= m || table[x + 1]![y]! >= table[x]![y + 1]!)) {
        middle.push({ kind: "-", line: am[x]! });
        x++;
      } else {
        middle.push({ kind: "+", line: bm[y]! });
        y++;
      }
    }
  }
  return [
    ...a.slice(0, pre).map((line) => ({ kind: " " as const, line })),
    ...middle,
    ...a.slice(a.length - suf).map((line) => ({ kind: " " as const, line })),
  ];
}
