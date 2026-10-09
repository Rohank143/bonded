import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { snippets } from "./snippets";

/**
 * Every import the copy-paste snippets show must exist in @bonded/sdk, or a builder's first paste
 * fails. Once the SDK's framework helpers are in this repository the test reads the package's
 * own exports map and sources; until then it checks against the list they were written from
 * (Track S, branch ux-sdk at 3574a88).
 */
const SDK_EXPORTS_AT_UX_SDK: Record<string, string[]> = {
  "@bonded/sdk": ["isBondedEpisode", "fromBondedEnv"],
  "@bonded/sdk/mcp": ["connectEpisodeTools", "mcpConfig", "mcpConfigJson", "finishEpisode"],
  "@bonded/sdk/agent-url": ["createBondedHandler", "toNodeHandler"],
  "@bonded/sdk/langchain": ["bondedLangChainTools"],
  "@bonded/sdk/ai-sdk": ["bondedAiSdkTools"],
  "@bonded/sdk/agentkit": ["bondedEpisodeActionProvider"],
  "@bonded/sdk/eliza": ["bondedEpisodePlugin", "bondedPlugin"],
};

// Tests run from apps/web (pnpm runs each package's tests in its own folder).
const sdkDir = `${resolve(process.cwd(), process.env.BONDED_SDK_DIR ?? "../../packages/sdk")}/`;

/** The SDK's real exports: subpath to the names its source file exports. Undefined before S lands. */
function realExports(): Record<string, (name: string) => boolean> | undefined {
  const pkg = JSON.parse(readFileSync(`${sdkDir}package.json`, "utf8")) as {
    exports: Record<string, string | { import?: string }>;
  };
  if (!pkg.exports["./langchain"]) return undefined;
  const out: Record<string, (name: string) => boolean> = {};
  for (const [sub, target] of Object.entries(pkg.exports)) {
    const js = typeof target === "string" ? target : target.import;
    if (!js?.endsWith(".js")) continue;
    const src = `${sdkDir}${js.replace("./dist/", "src/").replace(/\.js$/, ".ts")}`;
    if (!existsSync(src)) continue;
    const text = readFileSync(src, "utf8");
    out[sub === "." ? "@bonded/sdk" : `@bonded/sdk/${sub.slice(2)}`] = (name) =>
      new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
      ).test(text);
  }
  return out;
}

describe("snippet imports", () => {
  const real = realExports();
  const all = (["url", "runner"] as const).flatMap((c) =>
    (["tools", "chain"] as const).flatMap((m) => snippets(c, m)),
  );
  it.each(all.flatMap((s) => s.imports.flatMap((i) => i.names.map((n) => [s.label, i.from, n]))))(
    "%s: %s exports %s",
    (_label, from, name) => {
      if (real) {
        expect(real[from], `${from} is in the SDK's exports map`).toBeDefined();
        expect(real[from]!(name)).toBe(true);
      } else expect(SDK_EXPORTS_AT_UX_SDK[from]).toContain(name);
    },
  );
  it("knows whether it checked the real package", () => {
    // Fails loudly if the SDK changed shape so the reader found nothing.
    if (real) expect(Object.keys(real)).toContain("@bonded/sdk/agent-url");
    else expect(existsSync(`${sdkDir}package.json`)).toBe(true);
  });
});
