import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { agentConfig } from "../src/worker.js";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/seed-tee-agent.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const TEE_KEY = "0x239C0eD31e4e3313C06e8eD5C042dA6cB4c817BC";
const args = (extra: string[] = []) => [
  script,
  "--tee-address",
  TEE_KEY,
  "--tee-url",
  "https://agent.example",
  "--compose-hash",
  `0x${"ab".repeat(32)}`,
  "--code-hash",
  `0x${"cd".repeat(32)}`,
  ...extra,
];

describe("seed-tee-agent", () => {
  it("creates a vault run by the TEE's key and prints a config entry the API accepts", async () => {
    const { stdout } = await run(process.execPath, args(["--local"]), {
      cwd: root,
      timeout: 150_000,
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      agentId: string;
      vault: string;
      executionKey: string;
      entry: unknown;
    };
    expect(result.executionKey.toLowerCase()).toBe(TEE_KEY.toLowerCase());
    const config = agentConfig.parse(result.entry);
    expect(config.tee).toEqual({
      url: "https://agent.example",
      composeHash: `0x${"ab".repeat(32)}`,
    });
    expect(config.codeHash).toBe(`0x${"cd".repeat(32)}`);
    expect(config.mandate.agentId).toBe(result.agentId);
    expect(config.mandate.mode).toBe("enforce");
  }, 180_000);

  it("sends nothing on a dry run", async () => {
    const { stdout } = await run(process.execPath, args(["--dry-run"]), { cwd: root });
    expect(stdout).toMatch(/Nothing was sent/);
  });

  it("refuses bad arguments before touching a chain", async () => {
    for (const bad of [
      ["--tee-address", "nope"],
      ["--tee-url", "http://insecure.example"],
      ["--compose-hash", "0x12"],
      ["--code-hash", "0x12"],
    ]) {
      const replaced = args();
      const at = replaced.indexOf(bad[0]!);
      replaced.splice(at, 2, ...bad);
      await expect(run(process.execPath, replaced, { cwd: root })).rejects.toMatchObject({
        code: 2,
      });
    }
  });
});
