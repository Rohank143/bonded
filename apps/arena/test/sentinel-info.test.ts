import { expect, it } from "vitest";
import { sentinelInfo } from "../src/sentinel-info.js";

it("describes the guard the flags build, including a cascade's fallback", () => {
  expect(sentinelInfo("laya:http://x", undefined, "v3")).toEqual({
    model: "laya/typed-decisions",
    questions: "v3",
    blockThreshold: 0.7,
  });
  expect(sentinelInfo("laya:http://x", "openai/gpt-5-mini", "v3")).toEqual({
    model: "laya/typed-decisions",
    questions: "v3",
    blockThreshold: 0.7,
    fallback: { model: "openai/gpt-5-mini", questions: "v1", unsureBand: [0.25, 0.75] },
  });
  // An LLM guard alone asks the v1 questions.
  expect(sentinelInfo("openai/gpt-5-mini")).toMatchObject({
    model: "openai/gpt-5-mini",
    questions: "v1",
  });
});
