import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** The agent frameworks `init` knows. */
export const FRAMEWORKS = [
  "eliza",
  "agentkit",
  "langchain",
  "ai-sdk",
  "mcp",
  "python",
  "unknown",
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const FRAMEWORK_NAMES: Record<Framework, string> = {
  eliza: "ElizaOS",
  agentkit: "Coinbase AgentKit",
  langchain: "LangChain / LangGraph",
  "ai-sdk": "Vercel AI SDK",
  mcp: "an MCP client",
  python: "Python",
  unknown: "an unrecognised framework",
};

/** Web frameworks `init --url` can add an Agent URL route to. */
export type WebFramework = "next-app" | "next-pages" | "express" | "hono" | "node-http";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** What `init` found in the agent's folder. Paths are relative to `root`, with `/`. */
export interface Project {
  root: string;
  framework: Framework;
  /** Why it decided on the framework, in words. */
  evidence: string;
  packageManager: PackageManager;
  /** TypeScript (a tsconfig.json or a typescript dependency). */
  typescript: boolean;
  /** package.json `"type": "module"`: plain .js files are ES modules. */
  esm: boolean;
  /** How relative imports are written in TypeScript: with `.js` (NodeNext) or without. */
  importExtension: "" | ".js";
  /** Where source files live: `src` when there is one, else the root. */
  sourceDir: string;
  /** Source files (TS/JS), skipping node_modules, build output and tests. */
  sources: string[];
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  web: WebFramework;
  /** Next.js App Router folder (`app` or `src/app`), when there is one. */
  nextAppDir?: string;
  nextMajor?: number;
  hasSdk: boolean;
}

const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".git",
  ".turbo",
  "coverage",
  "test",
  "tests",
  "__tests__",
]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const MAX_SOURCES = 400;

export function detectProject(root: string, override?: Framework): Project {
  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath)
    ? (JSON.parse(readFileSync(pkgPath, "utf8")) as {
        type?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        packageManager?: string;
      })
    : undefined;
  const dependencies = { ...pkg?.devDependencies, ...pkg?.dependencies };
  const has = (name: string) => name in dependencies;
  const tsconfig = readTsconfig(root);
  const typescript = tsconfig !== undefined || has("typescript");
  const sourceDir =
    existsSync(join(root, "src")) && statSync(join(root, "src")).isDirectory() ? "src" : "";
  const sources = listSources(root);

  const found = override
    ? { framework: override, evidence: "chosen with --framework" }
    : detectFramework(root, pkg !== undefined, has, sources);

  const resolution = String(
    tsconfig?.compilerOptions?.moduleResolution ?? tsconfig?.compilerOptions?.module ?? "",
  ).toLowerCase();
  const nextAppDir = ["app", "src/app"].find((d) => existsSync(join(root, d)));
  const nextMajor = has("next")
    ? Number(/(\d+)/.exec(dependencies.next ?? "")?.[1]) || undefined
    : undefined;
  return {
    root,
    ...found,
    packageManager: packageManager(root, pkg?.packageManager),
    typescript,
    esm: pkg?.type === "module",
    importExtension:
      resolution.startsWith("node16") || resolution.startsWith("nodenext") ? ".js" : "",
    sourceDir,
    sources,
    dependencies,
    scripts: pkg?.scripts ?? {},
    web: has("next")
      ? nextAppDir
        ? "next-app"
        : "next-pages"
      : has("hono")
        ? "hono"
        : has("express")
          ? "express"
          : "node-http",
    ...(nextAppDir && has("next") ? { nextAppDir } : {}),
    ...(nextMajor ? { nextMajor } : {}),
    hasSdk: has("@bondedhq/sdk"),
  };
}

function detectFramework(
  root: string,
  hasPackageJson: boolean,
  has: (name: string) => boolean,
  sources: string[],
): { framework: Framework; evidence: string } {
  if (has("@coinbase/agentkit"))
    return { framework: "agentkit", evidence: "package.json depends on @coinbase/agentkit" };
  if (has("@elizaos/core"))
    return { framework: "eliza", evidence: "package.json depends on @elizaos/core" };
  const character = characterFile(root);
  if (character)
    return { framework: "eliza", evidence: `${character} looks like an ElizaOS character` };
  for (const name of ["@langchain/langgraph", "@langchain/core", "langchain"])
    if (has(name)) return { framework: "langchain", evidence: `package.json depends on ${name}` };
  if (has("ai"))
    return { framework: "ai-sdk", evidence: "package.json depends on ai (the Vercel AI SDK)" };
  if (has("@modelcontextprotocol/sdk"))
    return { framework: "mcp", evidence: "package.json depends on @modelcontextprotocol/sdk" };
  if (
    !hasPackageJson &&
    ["pyproject.toml", "requirements.txt", "setup.py"].some((f) => existsSync(join(root, f)))
  )
    return {
      framework: "python",
      evidence: "a Python project (pyproject.toml or requirements.txt)",
    };
  return {
    framework: "unknown",
    evidence: hasPackageJson
      ? `no known agent framework in package.json${sources.length ? "" : ", and no source files"}`
      : "no package.json",
  };
}

/** An ElizaOS character file: JSON with a name and plugins or bio. */
function characterFile(root: string): string | undefined {
  const candidates: string[] = [];
  for (const dir of ["", "characters"]) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const f of readdirSync(abs))
      if (f.endsWith(".character.json") || (dir === "characters" && f.endsWith(".json")))
        candidates.push(dir ? `${dir}/${f}` : f);
  }
  return candidates.find((f) => {
    try {
      const json = JSON.parse(readFileSync(join(root, f), "utf8")) as Record<string, unknown>;
      return typeof json.name === "string" && ("plugins" in json || "bio" in json);
    } catch {
      return false;
    }
  });
}

/** The package manager, from `packageManager` or the nearest lockfile (here or a parent folder). */
function packageManager(root: string, field: string | undefined): PackageManager {
  const named = /^(npm|pnpm|yarn|bun)@/.exec(field ?? "")?.[1] as PackageManager | undefined;
  if (named) return named;
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
    if (dirname(dir) === dir || existsSync(join(dir, ".git"))) return "npm";
  }
}

interface Tsconfig {
  compilerOptions?: { module?: string; moduleResolution?: string };
}

/** tsconfig.json, read leniently (comments and trailing commas allowed). */
function readTsconfig(root: string): Tsconfig | undefined {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8")
    .replace(
      /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (_, s: string | undefined) => s ?? "",
    )
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(text) as Tsconfig;
  } catch {
    return {};
  }
}

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_SOURCES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (
        entry.isFile() &&
        SOURCE.test(entry.name) &&
        !/\.(test|spec|d)\.[a-z]+$/.test(entry.name) &&
        !/\.config\.[a-z]+$/.test(entry.name)
      )
        out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}
