import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ArenaGateway,
  loadAttackLibrary,
  rateAgent,
  RemoteAgent,
  type RemoteRunSummary,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";
import { eventually } from "./fixtures/gateway-client.js";

/**
 * End to end: the real runner (apps/runner, built) as its own process, launching an agent script
 * that lives in a temporary folder and knows nothing of the Arena's code: the runner package's own
 * examples, with only the MCP SDK and viem next to them. Rated through rateAgent like any agent.
 */
const RUNNER_CLI = fileURLToPath(new URL("../../runner/dist/cli.js", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../../runner/examples/", import.meta.url));
const ARENA_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const TOKENS = { tools: "e2e-runner-token-tools-0001", chain: "e2e-runner-token-chain-0001" };

let sandbox: Sandbox;
let gateway: ArenaGateway;
let url: string;
let dir: string;
const runners: ChildProcess[] = [];
const library = loadAttackLibrary();
const pick = (...ids: string[]) => ids.map((id) => library.find((s) => s.id === id)!);

beforeAll(async () => {
  if (!existsSync(RUNNER_CLI)) throw new Error("build the runner first (pnpm build)");
  sandbox = await Sandbox.start();
  gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({
      [TOKENS.tools]: "e2e-tools",
      [TOKENS.chain]: "e2e-chain",
    }),
  });
  url = await gateway.listen();
  // The agent's own folder: the example scripts and their two dependencies, nothing else.
  dir = mkdtempSync(join(tmpdir(), "bonded-byo-agent-"));
  for (const file of ["mcp-agent.mjs", "chain-agent.mjs"])
    copyFileSync(join(EXAMPLES, file), join(dir, file));
  mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
  symlinkSync(
    realpathSync(join(ARENA_MODULES, "@modelcontextprotocol", "sdk")),
    join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
  );
  symlinkSync(realpathSync(join(ARENA_MODULES, "viem")), join(dir, "node_modules", "viem"));
  writeFileSync(
    join(dir, "hang.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "hang.pid"))}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
}, 180_000);

afterAll(async () => {
  for (const runner of runners) runner.kill("SIGTERM");
  await gateway?.close();
  await sandbox?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Starts the real runner CLI with the token in its environment, as the docs say to. */
async function startRunner(mode: "tools" | "chain", key: string, script: string) {
  const previous = gateway.runner(key);
  const runner = spawn(
    process.execPath,
    [RUNNER_CLI, "--gateway", url, "--mode", mode, "--quiet", "--", process.execPath, script],
    { cwd: dir, env: { ...process.env, BONDED_RUNNER_TOKEN: TOKENS[mode] }, stdio: "pipe" },
  );
  let log = "";
  runner.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  runners.push(runner);
  const connected = () => gateway.runner(key) !== undefined && gateway.runner(key) !== previous;
  await eventually(connected, 15_000).catch(() => {
    throw new Error(`the runner didn't connect:\n${log}`);
  });
  return {
    runner,
    log: () => log,
    stop: async () => {
      const exited = new Promise<number | null>((resolve) => runner.once("exit", resolve));
      runner.kill("SIGTERM");
      return exited;
    },
  };
}

const remoteOf = (summary: unknown) => (summary as RemoteRunSummary).remote;

describe("the real runner with an external agent", () => {
  it("rates an MCP agent through rateAgent", async () => {
    const { stop, log } = await startRunner("tools", "e2e-tools", join(dir, "mcp-agent.mjs"));
    const agent = new RemoteAgent({ gateway, sandbox, runner: "e2e-tools", mode: "tools" });
    const attacks = pick("A6-operator-impersonation-001", "A7-research-api-smuggling-001");
    const { report, episodes } = await rateAgent(sandbox, { agent, attacks, controls: 1 });
    expect(report.agent).toBe("remote/e2e-tools");
    expect(report.episodes).toMatchObject({ total: 3, attacks: 2, controls: 1, agentErrors: 0 });
    for (const episode of episodes) {
      expect(episode.agentSummary.stoppedBecause, log()).toBe("done");
      expect(episode.agentSummary.finalMessage).toMatch(/^Bought t[A-Z]+ with/);
      expect(remoteOf(episode.agentSummary).exitCode).toBe(0);
      expect(remoteOf(episode.agentSummary).stdoutTail).toMatch(/^Bought/);
      // It read the inbox, the news and the report, then made its one trade, over MCP.
      expect(episode.trace.map((s) => s.tool)).toEqual([
        "read_inbox",
        "read_news",
        "get_market_report",
        "get_token_info",
        "swap",
      ]);
      expect(episode.trace.at(-1)?.result.ok).toBe(true);
      // An agent that ignores what it reads isn't breached.
      expect(episode.verdict.breached).toBe(false);
    }
    expect(await stop()).toBe(0);
  });

  it("rates a chain-mode agent that signs its own trades", async () => {
    const { stop, log } = await startRunner("chain", "e2e-chain", join(dir, "chain-agent.mjs"));
    const agent = new RemoteAgent({ gateway, sandbox, runner: "e2e-chain", mode: "chain" });
    const { report, episodes } = await rateAgent(sandbox, {
      agent,
      attacks: pick("A2-fake-halt-news-001"),
      controls: 1,
    });
    expect(report.episodes.agentErrors, log()).toBe(0);
    for (const episode of episodes) {
      const writes = episode.trace.filter((s) => s.tool === "execute");
      // An approval for the exchange, then the swap: both its own transactions, both fine.
      expect(writes).toHaveLength(2);
      expect(writes.every((s) => s.result.ok && s.txHashes.length === 1)).toBe(true);
      expect(episode.verdict.breached).toBe(false);
      expect(episode.agentSummary.finalMessage).toMatch(/^Swapped/);
    }
    expect(await stop()).toBe(0);
  });

  it("stops an agent that runs past its deadline, process and all", async () => {
    const { stop } = await startRunner("tools", "e2e-tools", join(dir, "hang.mjs"));
    const agent = new RemoteAgent({
      gateway,
      sandbox,
      runner: "e2e-tools",
      mode: "tools",
      episodeTimeoutMs: 1_500,
    });
    const { episodes, report } = await rateAgent(sandbox, { agent, attacks: [], controls: 1 });
    expect(report.episodes.agentErrors).toBe(1);
    expect(episodes[0]?.agentSummary.finalMessage).toBe("timed out after 1500 ms");
    // It ignored SIGTERM, so the runner killed it.
    expect(remoteOf(episodes[0]!.agentSummary).signal).toBe("SIGKILL");
    const pid = Number(readFileSync(join(dir, "hang.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await stop()).toBe(0);
  });
});
