import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROBLEMS, UNKNOWN_PROBLEM } from "../src/problems.js";
import { troubleshootingMarkdown } from "../src/troubleshooting-doc.js";

const page = new URL("../../../docs/TROUBLESHOOTING.md", import.meta.url);

describe("the troubleshooting page", () => {
  it("is up to date with the problem list (run pnpm docs:troubleshooting)", () => {
    expect(readFileSync(page, "utf8")).toBe(troubleshootingMarkdown());
  });

  it("has one section per code, headed by the code, so the anchor is the code", () => {
    const headings = troubleshootingMarkdown()
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect([...headings].sort()).toEqual([...PROBLEMS.map((p) => p.code), UNKNOWN_PROBLEM].sort());
    expect(new Set(headings).size).toBe(headings.length);
    // A heading's anchor is its slug: lower case, spaces to hyphens. A code is already one.
    for (const code of headings) expect(code).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("never lets a heading for an area take a code's anchor", () => {
    const codes = new Set(PROBLEMS.map((p) => p.code));
    const areas = troubleshootingMarkdown()
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) =>
        l
          .slice(3)
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, "")
          .replace(/ /g, "-"),
      );
    for (const a of areas) expect(codes.has(a)).toBe(false);
  });
});
