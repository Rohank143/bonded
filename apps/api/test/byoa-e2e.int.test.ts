import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ANVIL_KEYS,
  ArenaGateway,
  Sandbox,
  createAgentVault,
  loadAttackLibrary,
  type AgentVault,
} from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import {
  bondedRegistryAbi,
  mandateHash,
  selfServeMessage,
  type SelfServeRequest,
} from "@bonded/shared";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { gatewayAgents } from "../src/remote-agent.js";
import { DbRunnerAuth, RunnerPresenceWriter } from "../src/runners.js";
import { workOne } from "../src/worker.js";
import { postgres } from "./postgres.js";

/**
 * Bring your own agent, end to end: the owner registers their agent and makes a runner token
 * through the API; the real runner (apps/runner, built) connects to the Arena Gateway with it and
 * starts an agent script that knows nothing of Bonded's code (the runner's own MCP example, in a
 * folder of its own); the owner asks for a rating; the worker rates the agent through the gateway
 * against a local chain, with a held-out set made for this rating, and posts the attestation; the
 * API then shows the score, its binding and the agent's coverage.
 */
const RUNNER_CLI = fileURLToPath(new URL("../../runner/dist/cli.js", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../../runner/examples/", import.meta.url));
const ARENA_MODULES = fileURLToPath(new URL("../../arena/node_modules/", import.meta.url));

let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let gateway: ArenaGateway;
let gatewayUrl: string;
let presence: RunnerPresenceWriter;
let app: ReturnType<typeof createApi>;
let mine: AgentVault;
let dir: string;
let runner: ChildProcess | undefined;
let runnerLog = "";
const owner = privateKeyToAccount(ANVIL_KEYS.operator);
const CODE = `0x${"c0de".repeat(16)}` as const;

beforeAll(async () => {
  if (!existsSync(RUNNER_CLI)) throw new Error("build the runner first (pnpm build)");
  pg = await postgres();
  sandbox = await Sandbox.start();
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  mine = await createAgentVault(sandbox);
  // The arena-worker's gateway, as main.ts starts it: tokens and presence in the database.
  presence = new RunnerPresenceWriter(pg.db);
  gateway = new ArenaGateway({
    tokens: new DbRunnerAuth(pg.db, sandbox.deployment.chainId),
    onRunnerPresence: presence.onEvent,
  });
  gatewayUrl = await gateway.listen();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
    gatewayUrl,
    // One run of each attack, to keep the test short.
    selfServe: { repeats: 1, requests: { perClient: 1000, total: 1000, windowMs: 60_000 } },
  });
  // The agent's own folder: the example script and the MCP SDK next to it, nothing else.
  dir = mkdtempSync(join(tmpdir(), "bonded-byoa-e2e-"));
  copyFileSync(join(EXAMPLES, "mcp-agent.mjs"), join(dir, "mcp-agent.mjs"));
  mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
  symlinkSync(
    realpathSync(join(ARENA_MODULES, "@modelcontextprotocol", "sdk")),
    join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
  );
}, 180_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  await gateway?.close();
  await sandbox?.stop();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);
const sign = (request: SelfServeRequest) =>
  owner.signMessage({ message: selfServeMessage(request) });
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
async function until(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${runnerLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it("registers, connects, rates and posts the score of an agent running on its own server", async () => {
  const agentId = mine.agentId.toString();
  const chainId = sandbox.deployment.chainId;

  // 1. The owner registers their own agent: tools mode, declared code hash, no TEE.
  const remote = { codeHash: CODE, mode: "tools" as const };
  let timestamp = now();
  const registered = await post("/self/agents", {
    agentId,
    vault: mine.address,
    kind: "remote",
    mandate: mine.mandate,
    ...remote,
    timestamp,
    signature: await sign({
      action: "register",
      chainId,
      agentId,
      vault: mine.address,
      kind: "remote",
      mandateHash: mandateHash(mine.mandate),
      remote,
      timestamp,
    }),
  });
  expect(registered.status).toBe(201);

  // 2. A runner token, signed for, shown once.
  timestamp = now();
  const made = await json(
    await post(`/self/agents/${agentId}/runner-token`, {
      timestamp,
      signature: await sign({ action: "runner-token", chainId, agentId, timestamp }),
    }),
  );
  expect(made.gatewayUrl).toBe(gatewayUrl);

  // 3. The real runner, started as the page says: token in the environment, agent after --.
  runner = spawn(
    process.execPath,
    [RUNNER_CLI, "--gateway", gatewayUrl, "--quiet", "--", process.execPath, "mcp-agent.mjs"],
    {
      cwd: dir,
      env: { ...process.env, BONDED_RUNNER_TOKEN: made.token as string },
      stdio: "pipe",
    },
  );
  runner.stderr?.on("data", (chunk: Buffer) => (runnerLog += chunk.toString()));
  await until(
    async () =>
      (
        (await json(await app.request(`/self/agents/${agentId}/runner`))).runner as {
          connected?: boolean;
        } | null
      )?.connected === true,
    20_000,
    "the runner to connect",
  );

  // 4. The owner asks for a rating; the worker runs it through the gateway and posts the score.
  timestamp = now();
  const rated = await post(`/self/agents/${agentId}/rate`, {
    timestamp,
    signature: await sign({ action: "rate", chainId, agentId, timestamp }),
  });
  expect(rated.status).toBe(202);
  const { runId } = (await rated.json()) as { runId: string };
  const ids = new Set([
    "A1-token-metadata-001",
    "A6-operator-impersonation-001",
    "A7-research-api-smuggling-001",
  ]);
  expect(loadAttackLibrary().filter((a) => ids.has(a.id))).toHaveLength(3);
  let failure: unknown;
  await workOne(
    pg.db,
    chain,
    sandbox.rpcUrl,
    ANVIL_KEYS.deployer,
    (e) => (failure = e),
    undefined,
    {
      remote: gatewayAgents(gateway),
      heldOut: { perClass: 1 },
      selectAttacks: (attacks) => attacks.filter((a) => ids.has(a.id)),
    },
  );
  expect(failure, runnerLog).toBeUndefined();
  const run = await json(await app.request(`/arena/runs/${runId}`));
  expect(run.status, String(run.error)).toBe("done");

  // 5. The registry holds the score; the API shows it with its binding, coverage and held-out set.
  const onchain = await chain.read.readContract({
    address: sandbox.deployment.registry,
    abi: bondedRegistryAbi,
    functionName: "scoreOf",
    args: [mine.agentId],
  });
  expect(onchain.codeHash).toBe(CODE);
  const score = await json(await app.request(`/agents/${agentId}/score`));
  expect(score.runId).toBe(runId);
  expect(score.binding).toBe("declared");
  const coverage = score.coverage as {
    readSurfaces: string[];
    surfaces: Record<string, { attacked: number; read: number }>;
  };
  // The example agent reads its inbox, the news, the market report and the token's info.
  expect(coverage.readSurfaces).toEqual(
    expect.arrayContaining(["dm", "news", "tool_output", "token_metadata"]),
  );
  expect(coverage.surfaces.dm!.attacked).toBeGreaterThan(0);
  const heldOut = score.heldOut as { seed: string; attacks: number; source: string };
  expect(heldOut.seed).toMatch(/^0x[0-9a-f]{64}$/);
  expect(heldOut.attacks).toBeGreaterThan(0);
  expect(heldOut.source).toBe("rewrite");
  const report = run.report as {
    agent: string;
    episodes: { total: number; agentErrors: number };
    unpublished: { attacks: number };
  };
  expect(report.agent).toBe(`remote/agent-${agentId}`);
  expect(report.episodes.agentErrors).toBe(0);
  // Three published attacks once, the held-out set, and two controls.
  expect(report.episodes.total).toBe(3 + heldOut.attacks + 2);
  expect(report.unpublished.attacks).toBe(heldOut.attacks);
  // The held-out payloads are on the ledger, so no later rating reuses them.
  expect(
    Number((await pg.db.pool.query("SELECT count(*) FROM held_out_payloads")).rows[0].count),
  ).toBe(heldOut.attacks);
}, 300_000);
