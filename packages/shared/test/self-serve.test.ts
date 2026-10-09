import { describe, expect, it } from "vitest";
import { REMOTE_MODES, selfServeMessage, SELF_SERVE_KINDS } from "../src/index.js";

describe("selfServeMessage", () => {
  it("states everything the signature authorises, one field a line", () => {
    expect(
      selfServeMessage({
        action: "register",
        chainId: 46630,
        agentId: "11",
        vault: "0xAbCdEf0000000000000000000000000000000001",
        kind: "partial",
        mandateHash: "0xABCD",
        timestamp: 1_800_000_000,
      }),
    ).toBe(
      "Bonded: register agent for ratings\nchain 46630\nagent 11\nvault 0xabcdef0000000000000000000000000000000001\ndesign partial\nmandate 0xabcd\ntime 1800000000",
    );
    expect(selfServeMessage({ action: "rate", chainId: 46630, agentId: "11", timestamp: 1 })).toBe(
      "Bonded: rate agent\nchain 46630\nagent 11\ntime 1",
    );
  });
  it("adds the Sentinel line only when it's chosen, so older signatures still verify", () => {
    const base = {
      action: "register" as const,
      chainId: 46630,
      agentId: "11",
      vault: "0x0000000000000000000000000000000000000001",
      kind: "hardened" as const,
      mandateHash: "0xab",
      timestamp: 5,
    };
    expect(selfServeMessage({ ...base, sentinel: true })).toBe(
      "Bonded: register agent for ratings\nchain 46630\nagent 11\nvault 0x0000000000000000000000000000000000000001\ndesign hardened\nmandate 0xab\nsentinel on\ntime 5",
    );
    expect(selfServeMessage({ ...base, sentinel: false })).toBe(selfServeMessage(base));
  });
  it("offers only Bonded's built-in scripted designs", () => {
    expect(SELF_SERVE_KINDS).toEqual(["vulnerable", "partial", "hardened"]);
  });
  it("signs a remote agent's declared code, mode and TEE, one field a line", () => {
    const base = {
      action: "register" as const,
      chainId: 46630,
      agentId: "12",
      vault: "0x0000000000000000000000000000000000000001",
      kind: "remote" as const,
      mandateHash: "0xAB",
      timestamp: 7,
    };
    const code = `0x${"C".repeat(64)}`;
    expect(selfServeMessage({ ...base, remote: { codeHash: code, mode: "tools" } })).toBe(
      `Bonded: register agent for ratings\nchain 46630\nagent 12\nvault 0x0000000000000000000000000000000000000001\ndesign remote\nmandate 0xab\ncode 0x${"c".repeat(64)}\nmode tools\ntime 7`,
    );
    const tee = { url: "https://Agent.example/x", composeHash: `0x${"D".repeat(64)}` };
    expect(selfServeMessage({ ...base, remote: { codeHash: code, mode: "chain", tee } })).toContain(
      `mode chain\ntee https://Agent.example/x\ncompose 0x${"d".repeat(64)}\ntime 7`,
    );
    expect(REMOTE_MODES).toEqual(["tools", "chain"]);
    // No declared code: the line is left out, and the reported hash is used instead.
    expect(selfServeMessage({ ...base, remote: { mode: "tools" } })).toBe(
      `Bonded: register agent for ratings\nchain 46630\nagent 12\nvault 0x0000000000000000000000000000000000000001\ndesign remote\nmandate 0xab\nmode tools\ntime 7`,
    );
  });
  it("names the runner token actions so one signature can't stand for the other", () => {
    const req = { chainId: 46630, agentId: "12", timestamp: 9 };
    const create = selfServeMessage({ action: "runner-token", ...req });
    const revoke = selfServeMessage({ action: "revoke-runner-token", ...req });
    expect(create).toBe("Bonded: create runner token\nchain 46630\nagent 12\ntime 9");
    expect(revoke).toBe("Bonded: revoke runner token\nchain 46630\nagent 12\ntime 9");
    expect(selfServeMessage({ action: "rate", ...req })).not.toBe(create);
  });
  it("says when the address is a smart account's module, and only then", () => {
    const base = {
      action: "register" as const,
      chainId: 46630,
      agentId: "13",
      vault: "0x0000000000000000000000000000000000000002",
      kind: "partial" as const,
      mandateHash: "0xab",
      timestamp: 5,
    };
    expect(selfServeMessage({ ...base, protection: "module" })).toBe(
      "Bonded: register agent for ratings\nchain 46630\nagent 13\nvault 0x0000000000000000000000000000000000000002\ndesign partial\nmandate 0xab\nprotection module\ntime 5",
    );
    expect(selfServeMessage({ ...base, protection: "vault" })).toBe(selfServeMessage(base));
  });
});
