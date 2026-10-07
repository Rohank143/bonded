import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { SENTINEL_GATES, SENTINEL_MODEL } from "./sentinel-facts";

it("states the five v5 gates honestly, including the one it failed", () => {
  expect(SENTINEL_GATES).toHaveLength(5);
  expect(SENTINEL_GATES.filter((g) => !g.passed).map((g) => g.name)).toEqual(["Stress suite"]);
});

it("names the revision production pins, so the page can't go stale silently", () => {
  const railway = readFileSync(resolve(__dirname, "../../../../.railway/railway.ts"), "utf8");
  expect(railway).toContain(`SENTINEL_MODEL_REVISION: "${SENTINEL_MODEL.revision}"`);
});

it("quotes the measured speeds from docs/SENTINEL.md", () => {
  const doc = readFileSync(resolve(__dirname, "../../../../docs/SENTINEL.md"), "utf8");
  expect(doc).toContain("p50 217 ms"); // T4 GPU, shown as 0.2 s
  expect(doc).toContain("about 2.5 s on CPU");
  expect(SENTINEL_MODEL.speed).toEqual({ gpu: "0.2 s", cpu: "2.5 s" });
});
