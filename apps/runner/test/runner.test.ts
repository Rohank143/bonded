import { createServer, type Server } from "node:http";
import {
  type EpisodeMessage,
  parseRunnerMessage,
  RUNNER_CLOSE,
  RUNNER_TAIL_BYTES,
  RunnerToServer,
  type ServerToRunner,
} from "@bonded/shared";
import { type WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { backoffDelay, Runner, type RunnerOptions, Tail } from "../src/index.js";

const TOKEN = "runner-test-token-123456";

/** A stand-in gateway: accepts the runner's WebSocket and records what it says. */
async function fakeGateway() {
  const server: Server = createServer((_, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const messages: RunnerToServer[] = [];
  const sockets: WebSocket[] = [];
  let connections = 0;
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      sockets.push(ws);
      ws.on("message", (data) => {
        const message = parseRunnerMessage(RunnerToServer, String(data));
        if (!message) throw new Error(`runner sent an invalid message: ${String(data)}`);
        messages.push(message);
        if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    messages,
    get connections() {
      return connections;
    },
    send: (message: ServerToRunner) => sockets.at(-1)!.send(JSON.stringify(message)),
    closeLatest: (code: number, reason = "") => sockets.at(-1)!.close(code, reason),
    of: <T extends RunnerToServer["type"]>(type: T) =>
      messages.filter((m): m is Extract<RunnerToServer, { type: T }> => m.type === type),
    close: async () => {
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function setup(options: Partial<RunnerOptions> & { command: string[] }) {
  const gateway = await fakeGateway();
  const runner = new Runner({
    gateway: gateway.url,
    token: TOKEN,
    mode: "tools",
    echo: false,
    heartbeatMs: 100,
    backoff: { initialMs: 20, maxMs: 50 },
    killGraceMs: 300,
    ...options,
  });
  const started = runner.start();
  stops.push(async () => {
    await runner.stop();
    await started;
    await gateway.close();
  });
  await eventually(() => gateway.of("hello").length > 0);
  return { gateway, runner, started };
}

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function episode(fields: Partial<EpisodeMessage> = {}): EpisodeMessage {
  const base = "http://gw.test/e/abc";
  return {
    type: "episode",
    episodeId: `ep-${Math.random().toString(36).slice(2)}`,
    task: { goal: "Buy 2000 tUSDG worth of tNVDA.", mandate: "Trade the basket.", maxSteps: 20 },
    mode: "tools",
    endpoints: {
      mcp: `${base}/mcp`,
      tools: `${base}/tools`,
      openapi: `${base}/openapi.json`,
      done: `${base}/done`,
    },
    chainId: 31337,
    vault: "0x000000000000000000000000000000000000dEaD",
    contracts: { exchange: "0x000000000000000000000000000000000000bEEF", tokens: [] },
    deadlineMs: 30_000,
    ...fields,
  };
}

const node = (script: string) => [process.execPath, "-e", script];

describe("the runner", () => {
  it("says hello with its mode and keeps a heartbeat", async () => {
    const { gateway } = await setup({ command: node(""), mode: "chain", version: "9.9.9" });
    expect(gateway.of("hello")[0]).toMatchObject({
      runnerVersion: "9.9.9",
      protocol: 1,
      mode: "chain",
    });
    await eventually(() => gateway.of("ping").length >= 2);
  });

  it("runs the agent with the episode in its environment, never the runner token", async () => {
    process.env.BONDED_RUNNER_TOKEN = "must-not-leak";
    try {
      const { gateway } = await setup({
        command: node(
          "const e=process.env;console.log(JSON.stringify({id:e.BONDED_EPISODE_ID,mcp:e.BONDED_MCP_URL," +
            "task:JSON.parse(e.BONDED_TASK),chain:e.BONDED_CHAIN_ID,deadline:e.BONDED_DEADLINE_MS," +
            "rpc:e.BONDED_RPC_URL??null,key:e.BONDED_SESSION_KEY??null,token:e.BONDED_RUNNER_TOKEN??null}))",
        ),
      });
      const ep = episode();
      gateway.send(ep);
      await eventually(() => gateway.of("episode_done").length === 1);
      expect(gateway.of("episode_started")).toEqual([
        { type: "episode_started", episodeId: ep.episodeId },
      ]);
      const done = gateway.of("episode_done")[0]!;
      expect(done).toMatchObject({ episodeId: ep.episodeId, exitCode: 0 });
      expect(JSON.parse(done.stdoutTail!)).toEqual({
        id: ep.episodeId,
        mcp: ep.endpoints.mcp,
        task: ep.task,
        chain: "31337",
        deadline: "30000",
        rpc: null,
        key: null,
        token: null,
      });
    } finally {
      delete process.env.BONDED_RUNNER_TOKEN;
    }
  });

  it("reports a failing agent's exit code and the last 4 KB of its output", async () => {
    const { gateway } = await setup({
      command: node(
        "process.stdout.write('a'.repeat(10000)+'END');process.stderr.write('boom');process.exit(3)",
      ),
    });
    gateway.send(episode());
    await eventually(() => gateway.of("episode_done").length === 1);
    const done = gateway.of("episode_done")[0]!;
    expect(done.exitCode).toBe(3);
    expect(done.stdoutTail).toHaveLength(RUNNER_TAIL_BYTES);
    expect(done.stdoutTail?.endsWith("END")).toBe(true);
    expect(done.stderrTail).toBe("boom");
  });

  it("stops an agent on cancel: SIGTERM, then SIGKILL if it won't exit", async () => {
    const { gateway } = await setup({
      command: node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"),
    });
    const ep = episode();
    gateway.send(ep);
    await eventually(() => gateway.of("episode_started").length === 1);
    // Give node time to install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    gateway.send({ type: "cancel", episodeId: ep.episodeId });
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("stops an agent past its deadline on its own, and runs one episode at a time", async () => {
    const { gateway } = await setup({ command: node("setInterval(()=>{},1000)") });
    const first = episode({ deadlineMs: 200 });
    gateway.send(first);
    await eventually(() => gateway.of("episode_started").length === 1);
    const second = episode();
    gateway.send(second);
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({
      episodeId: second.episodeId,
      error: "the runner is already running an episode",
    });
    await eventually(() => gateway.of("episode_done").length === 2, 3_000);
    expect(gateway.of("episode_done")[1]).toMatchObject({
      episodeId: first.episodeId,
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("reports a command that can't start", async () => {
    const { gateway } = await setup({ command: ["/no/such/agent-binary"] });
    gateway.send(episode());
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({ exitCode: null });
    expect(gateway.of("episode_done")[0]?.error).toMatch(/could not start the agent/);
  });

  it("forwards the TEE's evidence for the episode's nonce before starting the agent", async () => {
    const seen: string[] = [];
    const tee = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          quote: "0x01",
          nonce: new URL(req.url!, "http://x").searchParams.get("nonce"),
        }),
      );
    });
    await new Promise<void>((resolve) => tee.listen(0, "127.0.0.1", resolve));
    stops.push(() => new Promise((resolve) => tee.close(resolve)));
    const teeUrl = `http://127.0.0.1:${(tee.address() as { port: number }).port}`;
    const { gateway } = await setup({ command: node(""), teeUrl });
    const nonce = `0x${"ab".repeat(32)}` as const;
    gateway.send(episode({ nonce }));
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(seen).toEqual([`/attestation?nonce=${nonce}`]);
    expect(gateway.of("tee_evidence")[0]).toMatchObject({ evidence: { quote: "0x01", nonce } });
    const order = gateway.messages.map((m) => m.type).filter((t) => t !== "ping");
    expect(order.indexOf("tee_evidence")).toBeLessThan(order.indexOf("episode_started"));
  });

  it("says so when asked for TEE evidence without a TEE", async () => {
    const { gateway } = await setup({ command: node("") });
    gateway.send(episode({ nonce: `0x${"ab".repeat(32)}` }));
    await eventually(() => gateway.of("tee_evidence").length === 1);
    expect(gateway.of("tee_evidence")[0]?.error).toBe("this runner has no --tee-url");
  });

  it("reconnects with backoff after the connection drops, and kills the orphaned agent", async () => {
    const { gateway } = await setup({ command: node("setInterval(()=>{},1000)") });
    const ep = episode();
    gateway.send(ep);
    await eventually(() => gateway.of("episode_started").length === 1);
    gateway.closeLatest(1011, "server restart");
    await eventually(() => gateway.connections === 2 && gateway.of("hello").length === 2);
    // The episode's end, reported once it could be: on the new connection.
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({
      episodeId: ep.episodeId,
      exitCode: null,
    });
  });

  it("stops for good when its token is refused, revoked or taken over", async () => {
    const gateway = await fakeGateway();
    stops.push(() => gateway.close());
    const refused = new Runner({
      gateway: gateway.url,
      token: "wrong-token-000000000",
      mode: "tools",
      command: node(""),
    });
    expect(await refused.start()).toEqual({
      code: 2,
      reason: "the gateway refused the runner token (wrong or revoked)",
    });

    for (const [code, reason] of [
      [RUNNER_CLOSE.replaced, /another runner connected/],
      [RUNNER_CLOSE.revoked, /revoked/],
      [RUNNER_CLOSE.protocol, /upgrade the runner/],
    ] as const) {
      const before = gateway.connections;
      const runner = new Runner({
        gateway: gateway.url,
        token: TOKEN,
        mode: "tools",
        command: node(""),
      });
      const stopped = runner.start();
      await eventually(() => gateway.connections === before + 1);
      gateway.closeLatest(code);
      const result = await stopped;
      expect(result.code).toBe(2);
      expect(result.reason).toMatch(reason);
    }
  });
});

describe("helpers", () => {
  it("keeps only the last bytes of a stream", () => {
    const tail = new Tail(5);
    for (const part of ["ab", "cd", "ef", "gh"]) tail.push(Buffer.from(part));
    expect(tail.text()).toBe("defgh");
    const one = new Tail(5);
    one.push(Buffer.from("0123456789"));
    expect(one.text()).toBe("56789");
  });

  it("backs off exponentially up to a cap, with jitter", () => {
    const options = { initialMs: 1_000, maxMs: 30_000 };
    expect([1, 2, 3, 4, 5, 6, 9].map((a) => backoffDelay(a, options, () => 0.5))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(1, options, () => 0)).toBe(800);
    expect(backoffDelay(1, options, () => 1)).toBe(1_200);
  });
});
