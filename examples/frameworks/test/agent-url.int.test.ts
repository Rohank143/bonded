import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { signBondedRequest } from "@bonded/sdk/agent-url";
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
      expect(await post(url, { type: "verify", challenge: "ch-1" })).toMatchObject({
        status: 200,
        body: { challenge: "ch-1", version: "2026.10.1" },
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
      expect(await post(url, { type: "verify", challenge: "py" })).toMatchObject({
        status: 200,
        body: { challenge: "py", version: "py-1" },
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
    } finally {
      agent.kill();
    }
  });
});
