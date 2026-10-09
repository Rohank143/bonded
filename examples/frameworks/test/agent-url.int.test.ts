import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  loadAttackLibrary,
  RemoteAgent,
  type RemoteRunSummary,
  runEpisode,
  verifyAgentUrl,
} from "@bonded/arena";
import { signBondedRequest } from "@bonded/sdk/agent-url";
import { agentUrlCodeHash, agentUrlVerifyProof } from "@bonded/shared/agent-url";
import { createServer } from "node:http";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentUrlServer } from "../src/agent-url.js";
import { calls, messageFor, startArena, type TestArena } from "./arena.js";

/**
 * Agent URL mode end to end: Bonded's side is played by signed POSTs (as the gateway sends them),
 * the episode is a real Arena Gateway episode, and the agent is an HTTP server: the TypeScript
 * one built on `createBondedHandler`, and the Python example (skipped without python3).
 */
const SECRET = "bonded_as_e2e-test-secret-not-real";
const PYTHON_DIR = fileURLToPath(new URL("../../python-agent-url/", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

let arena: TestArena;
beforeAll(async () => {
  arena = await startArena();
}, 180_000);
afterAll(async () => {
  await arena?.stop();
});

async function post(url: string, message: unknown) {
  const body = JSON.stringify(message);
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await signBondedRequest(SECRET, body)) },
    body,
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
    ms: Date.now() - started,
  };
}

const usage = {
  inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe("a TypeScript agent on createBondedHandler", () => {
  it("verifies, acknowledges at once, works against the episode, then posts /done with usage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            { type: "tool-call", toolCallId: "a", toolName: "read_inbox", input: "{}" },
            {
              type: "tool-call",
              toolCallId: "b",
              toolName: "swap",
              input: JSON.stringify({ tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "300" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "bought" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const server = agentUrlServer({ secret: SECRET, model, version: "2026.10.1" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      expect(
        await post(url, { type: "verify", challenge: "challenge-from-a-test-0001" }),
      ).toMatchObject({
        status: 200,
        body: {
          challenge: "challenge-from-a-test-0001",
          proof: await agentUrlVerifyProof(SECRET, "challenge-from-a-test-0001"),
          version: "2026.10.1",
        },
      });
      const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
      const ack = await post(url, messageFor(episode));
      expect(ack).toMatchObject({ status: 202, body: { ok: true, episodeId: episode.episodeId } });
      expect(ack.ms).toBeLessThan(10_000);
      await expect(gatewayEpisode.done).resolves.toEqual({
        finalMessage: "bought",
        usage: { inputTokens: 160, outputTokens: 10 },
      });
      expect(calls(toolbox)).toEqual(["read_inbox:ok", "swap:ok"]);
      expect(await balance("tNVDA")).toBeGreaterThan(0n);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** A scripted model that reads three surfaces, then says it is done. */
const readingModel = () =>
  new MockLanguageModelV4({
    doGenerate: [
      {
        content: ["read_inbox", "read_news", "get_prices"].map((toolName, i) => ({
          type: "tool-call" as const,
          toolCallId: `r${i}`,
          toolName,
          input: "{}",
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "read everything; nothing to do" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });

const attack = () => loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;

/** An episode the gateway itself delivers: its own signed POST, through its Agent URL client. */
async function deliveredEpisode(url: string) {
  const agent = new RemoteAgent({
    gateway: arena.gateway,
    sandbox: arena.sandbox,
    transport: { kind: "url", url, secret: SECRET, registration: url },
    mode: "tools",
  });
  return runEpisode(arena.sandbox, { agent, attack: attack() });
}

describe("the gateway's own Agent URL calls, to createBondedHandler", () => {
  it("passes the gateway's verify challenge, and its version becomes the code hash", async () => {
    const server = agentUrlServer({ secret: SECRET, model: readingModel(), version: "2026.10.2" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      expect(await verifyAgentUrl(url, SECRET, { client: arena.gateway.agentUrls })).toEqual({
        ok: true,
        version: "2026.10.2",
        codeHash: agentUrlCodeHash("2026.10.2"),
      });
      // The wrong secret: the handler refuses the gateway's call.
      const wrong = await verifyAgentUrl(url, "bonded_as_not-this-agents-secret-000", {
        client: arena.gateway.agentUrls,
      });
      expect(wrong.ok).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses an echo server that sends the challenge back without the proof", async () => {
    // What a URL that doesn't hold the secret can do: reflect the body it was sent.
    const echo = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const { challenge } = JSON.parse(body) as { challenge: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge, proof: "0".repeat(64), version: "echo" }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/`;
      const result = await verifyAgentUrl(url, SECRET, { client: arena.gateway.agentUrls });
      expect(result.ok).toBe(false);
    } finally {
      echo.closeAllConnections();
      await new Promise((resolve) => echo.close(resolve));
    }
  });

  it("accepts the gateway's signed episode delivery, and the episode ends on /done", async () => {
    const server = agentUrlServer({ secret: SECRET, model: readingModel() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      const result = await deliveredEpisode(url);
      expect(result.agentSummary.stoppedBecause).toBe("done");
      expect(result.agentSummary.finalMessage).toBe("read everything; nothing to do");
      const record = (result.agentSummary as RemoteRunSummary).remote;
      expect(record).toMatchObject({ transport: "url" });
      expect(record.urlProblem).toBeUndefined();
      expect(result.trace.map((s) => s.tool)).toEqual(["read_inbox", "read_news", "get_prices"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe.skipIf(!hasPython)("the Python example (examples/python-agent-url)", () => {
  it("passes its own self-check", () => {
    const run = spawnSync("python3", ["-B", "selfcheck.py"], {
      cwd: PYTHON_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.stdout).toContain("selfcheck: ok");
    expect(run.status).toBe(0);
  });

  it("is rated against a real gateway episode, with requests the SDK signs", async () => {
    const agent: ChildProcess = spawn("python3", ["-B", "agent.py"], {
      cwd: PYTHON_DIR,
      env: {
        PATH: process.env.PATH,
        BONDED_AGENT_SECRET: SECRET,
        PORT: "0",
        HOST: "127.0.0.1",
        AGENT_VERSION: "py-1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        let out = "";
        agent.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /listening on :(\d+)/.exec(out);
          if (match) resolve(match[1]!);
        });
        agent.on("exit", (code) => reject(new Error(`agent.py exited with ${code}`)));
      });
      const url = `http://127.0.0.1:${port}/`;
      expect(
        await post(url, { type: "verify", challenge: "challenge-from-a-test-0002" }),
      ).toMatchObject({
        status: 200,
        body: {
          challenge: "challenge-from-a-test-0002",
          proof: await agentUrlVerifyProof(SECRET, "challenge-from-a-test-0002"),
          version: "py-1",
        },
      });

      const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
      expect((await post(url, messageFor(episode))).status).toBe(202);
      const done = await gatewayEpisode.done;
      expect(done.finalMessage).toMatch(/swapped/);
      const seen = calls(toolbox);
      expect(seen).toEqual(
        expect.arrayContaining(["read_inbox:ok", "read_news:ok", "get_prices:ok", "swap:ok"]),
      );
      expect(await balance("tNVDA")).toBeGreaterThan(0n);

      // And the gateway's own calls: its verify challenge, and a signed episode it delivers.
      expect(await verifyAgentUrl(url, SECRET, { client: arena.gateway.agentUrls })).toEqual({
        ok: true,
        version: "py-1",
        codeHash: agentUrlCodeHash("py-1"),
      });
      const result = await deliveredEpisode(url);
      expect(result.agentSummary.stoppedBecause).toBe("done");
      expect(result.trace.map((s) => s.tool)).toEqual(
        expect.arrayContaining(["read_inbox", "read_counterparty_messages"]),
      );
    } finally {
      agent.kill();
    }
  });
});
