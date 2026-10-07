import { describe, expect, it } from "vitest";
import {
  codeHashError,
  composeHashError,
  coverageRows,
  lapseReason,
  normaliseCodeHash,
  policyCoverCap,
  runnerCommand,
  runnerDockerCommand,
  runnerView,
  teeUrlError,
} from "./byoa";
import type { RunnerRecord, SelfAgentRecord } from "./api";

const hex = (c: string) => `0x${c.repeat(64)}`;

describe("runner commands", () => {
  const base = { gatewayUrl: "https://gw.example", token: "bonded_rt_abc", mode: "tools" as const };

  it("give the gateway and token, and leave the agent command for the owner", () => {
    expect(runnerCommand(base)).toBe(
      "npx @bonded/runner --gateway https://gw.example --token bonded_rt_abc -- <your agent command>",
    );
    expect(runnerDockerCommand(base)).toBe(
      "docker run --rm ghcr.io/ddboy19912/bonded-runner --gateway https://gw.example --token bonded_rt_abc -- <your agent command>",
    );
  });

  it("add chain mode and the TEE's URL only when they apply", () => {
    expect(runnerCommand({ ...base, mode: "chain", teeUrl: "https://tee.example" })).toBe(
      "npx @bonded/runner --gateway https://gw.example --token bonded_rt_abc --mode chain --tee-url https://tee.example -- <your agent command>",
    );
  });
});

describe("runnerView", () => {
  const record = (over: Partial<RunnerRecord>): RunnerRecord => ({
    token: { id: "t", createdAt: "2026-10-07T00:00:00Z" },
    runner: null,
    lastSkip: null,
    gatewayUrl: null,
    ...over,
  });
  const runner = (connected: boolean) => ({
    connected,
    connectedAt: "",
    lastHeartbeatAt: "",
    disconnectedAt: null,
    runnerVersion: "0.1.0",
    mode: "chain",
    teeUrl: "https://tee.example",
  });

  it("reads each state in plain words", () => {
    expect(runnerView(undefined).label).toBe("no token");
    expect(runnerView(record({ token: null })).label).toBe("no token");
    expect(runnerView(record({}))).toMatchObject({ label: "waiting", tone: "warn" });
    const live = runnerView(record({ runner: runner(true) }));
    expect(live).toMatchObject({ label: "connected", tone: "safe" });
    expect(live.hint).toMatch(/chain mode, with a TEE/);
    expect(runnerView(record({ runner: runner(false) }))).toMatchObject({ label: "offline" });
  });
});

describe("lapseReason", () => {
  it("explains a lapsed score by the runner being away", () => {
    expect(lapseReason({ expired: false, connected: false })).toBeUndefined();
    expect(lapseReason({ expired: true, connected: false })).toMatch(
      /runner wasn't connected to renew it/,
    );
    expect(lapseReason({ expired: true, connected: true })).toMatch(/renewal is queued/);
  });
});

describe("what the owner declares", () => {
  it("takes a 32-byte code hash, including docker's sha256: form", () => {
    expect(codeHashError("")).toMatch(/Enter/);
    expect(codeHashError("0x1234")).toMatch(/64 hex digits/);
    expect(codeHashError(hex("a"))).toBeNull();
    expect(codeHashError(`sha256:${"b".repeat(64)}`)).toBeNull();
    expect(normaliseCodeHash(` sha256:${"b".repeat(64)} `)).toBe(hex("b"));
  });

  it("wants an https TEE URL with its compose hash, or neither", () => {
    expect(teeUrlError("")).toBeNull();
    expect(teeUrlError("http://tee.example")).toMatch(/https/);
    expect(teeUrlError("nope")).toMatch(/isn't a URL/);
    expect(teeUrlError("https://tee.example")).toBeNull();
    expect(composeHashError("", "")).toBeNull();
    expect(composeHashError(hex("c"), "")).toMatch(/URL too/);
    expect(composeHashError("", "https://tee.example")).toMatch(/compose hash/);
    expect(composeHashError("c".repeat(64), "https://tee.example")).toBeNull();
  });
});

describe("coverageRows", () => {
  it("lists attacked surfaces, most attacked first, in plain names", () => {
    expect(coverageRows(null)).toEqual([]);
    const rows = coverageRows({
      surfaces: {
        dm: { attacked: 10, read: 10 },
        news: { attacked: 0, read: 4 },
        token_metadata: { attacked: 15, read: 0 },
      },
      readSurfaces: ["dm", "news"],
    });
    expect(rows).toEqual([
      { surface: "token_metadata", label: "token info", attacked: 15, read: 0 },
      { surface: "dm", label: "messages", attacked: 10, read: 10 },
    ]);
  });
});

describe("policyCoverCap", () => {
  const remote: SelfAgentRecord = {
    registered: true,
    source: "user",
    kind: "remote",
    owner: null,
    lastRatingAt: null,
    nextRatingAt: null,
    coverCaps: { declared: 5_000, tee: 20_000 },
  };
  it("applies only to an agent its owner runs, by binding, declared until proven", () => {
    expect(policyCoverCap(remote, undefined)).toEqual({ usd: 5_000, binding: "declared" });
    expect(policyCoverCap(remote, "tee")).toEqual({ usd: 20_000, binding: "tee" });
    expect(policyCoverCap({ ...remote, kind: "partial" }, "declared")).toBeUndefined();
    expect(policyCoverCap({ registered: false }, "declared")).toBeUndefined();
  });
});
