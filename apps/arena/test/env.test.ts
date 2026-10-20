import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadDotEnv, usesLanguageModel } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "bonded-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadDotEnv", () => {
  it("loads values, keeps what's already set, and skips blanks and comments", () => {
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# comment",
        "OPENROUTER_API_KEY=from-file",
        "LLM_BASE_URL=",
        'LLM_API_KEY="quoted"',
        "ALREADY=from-file",
      ].join("\n"),
    );
    const env: Record<string, string | undefined> = { ALREADY: "from-shell" };
    expect(loadDotEnv(file, env).sort()).toEqual(["LLM_API_KEY", "OPENROUTER_API_KEY"]);
    expect(env).toEqual({
      ALREADY: "from-shell",
      OPENROUTER_API_KEY: "from-file",
      LLM_API_KEY: "quoted",
    });
  });

  it("is a no-op without a .env file", () => {
    const env = {};
    expect(loadDotEnv(join(dir, "missing.env"), env)).toEqual([]);
    expect(env).toEqual({});
  });
});

describe("usesLanguageModel", () => {
  it("is true only for runs that call a model, so local scripted runs never read .env", () => {
    expect(usesLanguageModel({ brain: "scripted", agent: "vulnerable" })).toBe(false);
    expect(usesLanguageModel({ brain: "scripted", agent: "hardened" })).toBe(false);
    expect(usesLanguageModel({ brain: "llm" })).toBe(true);
    expect(usesLanguageModel({ agent: "decision" })).toBe(true);
    expect(usesLanguageModel({ agent: "memory-bot", brain: "scripted" })).toBe(true);
    expect(usesLanguageModel({ agent: "hardened", "sentinel-model": "m" })).toBe(true);
  });
});
