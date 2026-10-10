import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendEnvNames, applyPlan, insideProject } from "../src/init/apply.js";
import { agentCommand, initCommand } from "../src/init/command.js";
import { detectProject } from "../src/init/detect.js";
import { unifiedDiff } from "../src/init/diff.js";
import { addImport, type InitPlan, planInit } from "../src/init/plan.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const REPO = join(import.meta.dirname, "../../..");
const requireHere = createRequire(import.meta.url);
const fixture = (name: string) => join(FIXTURES, name);

/** What `init --print` shows for a plan: each diff, then what to do by hand. */
function render(plan: InitPlan): string {
  return [
    ...plan.changes.map((c) => unifiedDiff(c.path, c.before, c.after)),
    ...(plan.manual.length ? [`# By hand\n${plan.manual.map((m) => `- ${m}`).join("\n")}\n`] : []),
    `# Variables\n${plan.env.join(", ") || "(none)"}\n# Adds\n${plan.install.join(" ") || "(nothing)"}\n`,
  ].join("\n");
}

const temps: string[] = [];
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));
function copy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bonded-init-${name}-`));
  temps.push(dir);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

describe("detectProject", () => {
  it.each([
    ["langchain", "langchain", "npm", true],
    ["ai-sdk", "ai-sdk", "pnpm", true],
    ["agentkit", "agentkit", "yarn", true],
    ["eliza", "eliza", "bun", true],
    ["mcp-js", "mcp", "npm", false],
    ["unknown-cjs", "unknown", "npm", false],
    ["python", "python", undefined, false],
  ] as const)("%s: %s with %s", (name, framework, pm, ts) => {
    const p = detectProject(fixture(name));
    expect(p.framework).toBe(framework);
    if (pm) expect(p.packageManager).toBe(pm);
    expect(p.typescript).toBe(ts);
  });

  it("reads how the project writes relative imports, and its web framework", () => {
    expect(detectProject(fixture("langchain")).importExtension).toBe(".js");
    expect(detectProject(fixture("ai-sdk")).importExtension).toBe("");
    expect(detectProject(fixture("next-app"))).toMatchObject({
      web: "next-app",
      nextAppDir: "app",
      nextMajor: 15,
    });
    expect(detectProject(fixture("express-ai-sdk")).web).toBe("express");
    expect(detectProject(fixture("hono")).web).toBe("hono");
    expect(detectProject(fixture("langchain")).web).toBe("node-http");
  });
});

describe("planInit: the proposed diff, per framework", () => {
  it.each([
    ["langchain", {}],
    ["ai-sdk", {}],
    ["agentkit", {}],
    ["eliza", {}],
    ["mcp-js", {}],
    ["unknown-cjs", {}],
    ["python", {}],
    ["next-app", { url: true }],
    ["express-ai-sdk", { url: true }],
    ["hono", { url: true }],
    ["langchain", { url: true }],
  ] as [string, { url?: boolean }][])("%s %o", async (name, options) => {
    const plan = planInit(detectProject(fixture(name)), options);
    await expect(render(plan)).toMatchFileSnapshot(
      `__snapshots__/init/${name}${options.url ? "-url" : ""}.diff`,
    );
  });

  it("is idempotent: run again on its own result, it proposes nothing more", () => {
    for (const name of ["langchain", "ai-sdk", "agentkit", "eliza", "mcp-js"]) {
      const dir = copy(name);
      applyPlan(dir, planInit(detectProject(dir)));
      const again = planInit(detectProject(dir));
      expect(again.changes, name).toEqual([]);
      expect(again.manual, name).toEqual([]);
    }
  });

  it("prints instructions instead of guessing between two tool lists", () => {
    const dir = copy("langchain");
    const file = join(dir, "src/agent.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nexport const tools = [];\n`);
    const plan = planInit(detectProject(dir));
    expect(plan.changes.map((c) => c.path)).toEqual(["src/bonded.ts"]);
    expect(plan.manual[0]).toMatch(/found 2 `const tools = \.\.\.` lines/);
  });

  it("won't await outside an async function", () => {
    const dir = copy("langchain");
    writeFileSync(
      join(dir, "src/agent.ts"),
      "export function build() {\n  const tools = [1, 2];\n  return tools;\n}\n",
    );
    const plan = planInit(detectProject(dir));
    expect(plan.manual[0]).toMatch(/isn't in an async function/);
  });

  it("leaves a file it didn't write alone, and names its own helper file instead", () => {
    const dir = copy("ai-sdk");
    writeFileSync(join(dir, "src/bonded.ts"), "export const mine = 1;\n");
    const plan = planInit(detectProject(dir));
    expect(plan.changes.find((c) => c.path === "src/bonded.ts")).toBeUndefined();
    expect(plan.changes.map((c) => c.path)).toEqual(["src/bonded-agent.ts", "src/index.ts"]);
    expect(plan.notes.join("\n")).toMatch(
      /src\/bonded.ts is your own file, so init's helper is src\/bonded-agent.ts/,
    );
    // And the next free name when that one is taken too; a rerun picks the same file again.
    writeFileSync(join(dir, "src/bonded-agent.ts"), "export const alsoMine = 1;\n");
    const next = planInit(detectProject(dir));
    expect(next.changes.map((c) => c.path)).toEqual(["src/bonded-agent-2.ts", "src/index.ts"]);
    applyPlan(dir, next);
    expect(planInit(detectProject(dir)).changes).toEqual([]);
  });

  it.each([
    ["langchain", "src/bonded.ts", "src/bonded-agent.ts", "bondedTools"],
    ["ai-sdk", "src/bonded.ts", "src/bonded-agent.ts", "bondedTools"],
    ["agentkit", "src/bonded.ts", "src/bonded-agent.ts", "bondedAgentKit"],
    ["eliza", "src/bonded.ts", "src/bonded-agent.ts", "bondedPlugins"],
    ["mcp-js", "bonded.js", "bonded-agent.js", "bondedMcpUrl"],
  ])("%s: with the project's own %s, every edit imports from %s", (name, own, helper, binding) => {
    const dir = copy(name);
    writeFileSync(join(dir, own), "export const mine = 1;\n");
    const plan = planInit(detectProject(dir), { url: true });
    expect(plan.changes.map((c) => c.path)).toContain(helper);
    expect(plan.changes.map((c) => c.path)).not.toContain(own);
    const base = helper.replace(/\.(ts|js)$/, "");
    const imports = plan.changes
      .filter((c) => c.path !== helper)
      .flatMap((c) => [
        ...c.after.matchAll(new RegExp(`import \\{ ${binding} \\} from "([^"]+)"`, "g")),
      ])
      .map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports)
      expect(specifier).toMatch(new RegExp(`${base.split("/").pop()}(\\.js)?$`));
    expect(plan.manual.join("\n")).not.toContain(`${own} already exists`);
  });

  it("typechecks after apply when the project has its own src/bonded.ts", () => {
    const dir = copy("ai-sdk-collision");
    const own = readFileSync(join(dir, "src/bonded.ts"), "utf8");
    applyPlan(dir, planInit(detectProject(dir)));
    expect(readFileSync(join(dir, "src/bonded.ts"), "utf8")).toBe(own);
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain(
      'import { bondedTools } from "./bonded-agent";',
    );
    // The packages the project would install, linked from this repository.
    const link = (name: string, target: string) => {
      mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
      symlinkSync(target, join(dir, "node_modules", name), "dir");
    };
    const sdk = join(REPO, "packages/sdk");
    link("@bondedhq/sdk", sdk);
    link("ai", realpathSync(join(sdk, "node_modules/ai")));
    link("@types/node", realpathSync(join(REPO, "node_modules/@types/node")));
    const tsc = spawnSync(
      process.execPath,
      [requireHere.resolve("typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")],
      { encoding: "utf8" },
    );
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  });
});

describe("addImport", () => {
  it("goes after the last import, past a multi-line one, a shebang and directives", () => {
    const text =
      '#!/usr/bin/env node\n"use strict";\nimport {\n  a,\n  b,\n} from "x";\n\nconst y = 1;\n';
    expect(addImport(text, 'import { z } from "./z";', "./z")).toBe(
      '#!/usr/bin/env node\n"use strict";\nimport {\n  a,\n  b,\n} from "x";\nimport { z } from "./z";\n\nconst y = 1;\n',
    );
    expect(addImport("const y = 1;\n", 'import { z } from "./z";', "./z")).toBe(
      'import { z } from "./z";\nconst y = 1;\n',
    );
  });
});

describe("applying", () => {
  it("never writes outside the project", () => {
    const dir = copy("langchain");
    expect(() => insideProject(dir, "../evil.ts")).toThrow(/outside the project/);
    expect(() => insideProject(dir, "/etc/passwd")).toThrow(/not a path in the project/);
    const plan: InitPlan = {
      framework: "langchain",
      changes: [{ path: "../x.ts", after: "", why: "" }],
      manual: [],
      notes: [],
      env: [],
      install: [],
    };
    expect(() => applyPlan(dir, plan)).toThrow(/outside the project/);
  });

  it("refuses a file that changed since the plan was made", () => {
    const dir = copy("langchain");
    const plan = planInit(detectProject(dir));
    writeFileSync(join(dir, "src/agent.ts"), "// changed\n");
    expect(() => applyPlan(dir, plan)).toThrow(/src\/agent.ts changed since init read it/);
  });

  it("appends only the missing names to .env, with empty values, and keeps what is there", () => {
    const dir = copy("langchain");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-secret\nBONDED_AGENT_KEY=0xabc");
    expect(appendEnvNames(dir, ["BONDED_VAULT_ADDRESS", "BONDED_AGENT_KEY"])).toEqual([
      "BONDED_VAULT_ADDRESS",
    ]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "OPENAI_API_KEY=sk-secret\nBONDED_AGENT_KEY=0xabc\n\n# Bonded (bonded-runner init): fill these in\nBONDED_VAULT_ADDRESS=\n",
    );
    expect(appendEnvNames(dir, ["BONDED_VAULT_ADDRESS"])).toEqual([]);
  });
});

describe("initCommand", () => {
  const io = (cwd: string, answers: boolean[] = []) => {
    const out: string[] = [];
    const ran: string[][] = [];
    return {
      out,
      ran,
      io: {
        cwd,
        env: {},
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(`ERR ${l}`),
        confirm: async () => answers.shift() ?? false,
        run: async (cmd: string[]) => {
          ran.push(cmd);
          return 0;
        },
      },
    };
  };

  it("--print shows the diff and writes nothing", async () => {
    const dir = copy("ai-sdk");
    const t = io(dir);
    expect(await initCommand(["--print"], t.io)).toBe(0);
    expect(t.out.join("\n")).toMatch(/Framework: Vercel AI SDK \(package.json depends on ai/);
    expect(t.out.join("\n")).toContain(
      "+  const tools = await bondedTools({ get_price: getPrice });",
    );
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).not.toContain("bondedTools");
    expect(t.ran).toEqual([]);
  });

  it("asks first; no writes on no", async () => {
    const dir = copy("ai-sdk");
    const t = io(dir, [false]);
    expect(await initCommand([], t.io)).toBe(0);
    expect(t.out).toContain("Nothing written.");
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).not.toContain("bondedTools");
  });

  it("on yes writes the files and adds the SDK with the project's package manager", async () => {
    const dir = copy("ai-sdk");
    const t = io(dir, [true]);
    expect(await initCommand(["--env"], t.io)).toBe(0);
    expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain("await bondedTools(");
    expect(t.ran).toEqual([["pnpm", "add", "@bondedhq/sdk"]]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("BONDED_VAULT_ADDRESS=\n");
    expect(t.out.join("\n")).toMatch(/Next: start the runner/);
  });

  it("--yes connects when given a token and a gateway, with the start script as the command", async () => {
    const dir = copy("langchain");
    const connects: unknown[] = [];
    const t = io(dir);
    const code = await initCommand(
      [
        "--yes",
        "--skip-install",
        "--gateway",
        "https://arena.example.com",
        "--api",
        "https://api.example.com",
        "--preview",
        "p1",
      ],
      {
        ...t.io,
        env: { BONDED_RUNNER_TOKEN: "rt", BONDED_SESSION_TOKEN: "bonded_ss_x" },
        connect: async (o) => {
          connects.push({ ...o, out: undefined, err: undefined });
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(connects).toEqual([
      expect.objectContaining({
        gateway: "https://arena.example.com",
        token: "rt",
        mode: "tools",
        command: ["npm", "run", "start"],
        check: {
          api: "https://api.example.com",
          session: "bonded_ss_x",
          subject: { kind: "preview", id: "p1" },
        },
      }),
    ]);
    expect(t.ran).toEqual([]);
  });

  it("checks with the runner token alone, against the default API, when there's no session", async () => {
    const dir = copy("langchain");
    const t = io(dir);
    const connects: unknown[] = [];
    const code = await initCommand(
      ["--yes", "--skip-install", "--gateway", "https://arena.example.com"],
      {
        ...t.io,
        env: { BONDED_RUNNER_TOKEN: "bonded_rt_x" },
        connect: async (o) => {
          connects.push({ ...o, out: undefined, err: undefined });
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(connects).toEqual([
      expect.objectContaining({
        token: "bonded_rt_x",
        check: { api: "https://api-production-ba50.up.railway.app", runnerToken: "bonded_rt_x" },
      }),
    ]);
    // The token came from the environment, so there is nothing to warn about.
    expect(t.out.join("\n")).not.toMatch(/process list/);
  });

  it("warns when the token is on the command line, and can skip the check", async () => {
    const dir = copy("langchain");
    const t = io(dir);
    const connects: { check?: unknown }[] = [];
    const code = await initCommand(
      [
        "--yes",
        "--skip-install",
        "--token",
        "bonded_rt_x",
        "--gateway",
        "https://arena.example.com",
        "--api",
        "https://api.example.com",
        "--skip-check",
      ],
      {
        ...t.io,
        connect: async (o) => {
          connects.push(o);
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(connects[0]!.check).toBeUndefined();
    expect(t.out.join("\n")).toMatch(/shows in the process list/);
  });

  it("refuses a plain http API off this machine", async () => {
    const dir = copy("langchain");
    const t = io(dir);
    const code = await initCommand(
      [
        "--yes",
        "--skip-install",
        "--gateway",
        "https://arena.example.com",
        "--api",
        "http://api.example.com",
      ],
      { ...t.io, env: { BONDED_RUNNER_TOKEN: "rt" }, connect: async () => 0 },
    );
    expect(code).toBe(1);
    expect(t.out.join("\n")).toMatch(/--api must be https/);
  });

  it("refuses plain http to a remote gateway", async () => {
    const dir = copy("langchain");
    const t = io(dir);
    const code = await initCommand(
      ["--yes", "--skip-install", "--token", "rt", "--gateway", "http://arena.example.com"],
      t.io,
    );
    expect(code).toBe(1);
    expect(t.out.join("\n")).toMatch(/must be https/);
  });

  it("keeps a generated file you edited: a rerun, plain or --yes, never deletes your onEpisode", async () => {
    const dir = copy("express-ai-sdk");
    const handler = join(dir, "src/bonded-agent-url.ts");
    expect(await initCommand(["--url", "--yes", "--skip-install"], io(dir).io)).toBe(0);
    // Implement the handler, keeping init's header line.
    const implemented = readFileSync(handler, "utf8").replace(
      /throw new Error\([^\n]*\);/,
      "return { finalMessage: `ran ${episode.task.goal}` };",
    );
    expect(implemented).toContain("return { finalMessage");
    writeFileSync(handler, implemented);

    const plain = io(dir, [true]);
    expect(await initCommand(["--url"], plain.io)).toBe(0);
    expect(readFileSync(handler, "utf8")).toBe(implemented);
    expect(plain.out.join("\n")).toMatch(/Kept your edited file src\/bonded-agent-url.ts/);
    expect(plain.out.join("\n")).not.toMatch(/wrote src\/bonded-agent-url.ts/);

    const yes = io(dir);
    expect(await initCommand(["--url", "--yes", "--skip-install"], yes.io)).toBe(0);
    expect(readFileSync(handler, "utf8")).toBe(implemented);
    expect(yes.out.join("\n")).toMatch(/Kept your edited file src\/bonded-agent-url.ts/);

    // Only on request, and the diff shows what goes.
    const overwrite = io(dir);
    expect(
      await initCommand(
        ["--url", "--yes", "--skip-install", "--overwrite-generated"],
        overwrite.io,
      ),
    ).toBe(0);
    expect(overwrite.out.join("\n")).toContain(
      "-      return { finalMessage: `ran ${episode.task.goal}` };",
    );
    expect(overwrite.out).toContain("wrote src/bonded-agent-url.ts");
    expect(readFileSync(handler, "utf8")).not.toContain("return { finalMessage");
  });

  it("uses the command after -- over the start script", () => {
    const p = detectProject(fixture("langchain"));
    expect(agentCommand(p, ["node", "a.js"])).toEqual(["node", "a.js"]);
    expect(agentCommand(detectProject(fixture("hono")), [])).toEqual([]);
  });
});
