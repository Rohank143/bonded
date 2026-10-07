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
