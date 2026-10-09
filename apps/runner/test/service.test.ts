import { describe, expect, it } from "vitest";
import { serviceCommand } from "../src/service.js";

function print(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = serviceCommand(argv, {
    cwd: "/srv/my-agent",
    env: {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    user: "agent",
    nodeBin: "/usr/local/node/bin",
  });
  return { code, out: out.join(""), err: err.join("") };
}

const ARGS = [
  "--gateway",
  "https://arena.example.com",
  "--",
  "node",
  "dist/agent.js",
  "--say",
  "it's",
];

describe("bonded-runner service --print", () => {
  it.each(["systemd", "pm2", "docker"])("%s", async (kind) => {
    const { code, out } = print(["--print", kind, ...ARGS]);
    expect(code).toBe(0);
    expect(out).not.toMatch(/BONDED_RUNNER_TOKEN=(?!\.\.\.)\S/);
    await expect(out).toMatchFileSnapshot(`__snapshots__/service/${kind}.txt`);
  });

  it("chain mode and a name", () => {
    const { out } = print(["--print", "pm2", "--mode", "chain", "--name", "trader", ...ARGS]);
    expect(out).toContain('"--mode","chain"');
    expect(out).toContain('name: "trader"');
  });

  it("names what is missing", () => {
    const { code, err } = print(["--print", "launchd", "--name", "a b"]);
    expect(code).toBe(1);
    expect(err).toMatch(
      /Missing or invalid: --print systemd\|pm2\|docker, --gateway, an agent command after --, --name/,
    );
  });

  it("refuses plain http to a remote gateway", () => {
    const { code, err } = print([
      "--print",
      "systemd",
      "--gateway",
      "http://arena.example.com",
      "--",
      "node",
      "a.js",
    ]);
    expect(code).toBe(1);
    expect(err).toMatch(/must be https/);
  });
});
