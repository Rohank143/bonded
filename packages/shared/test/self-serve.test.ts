import { describe, expect, it } from "vitest";
import { selfServeMessage, SELF_SERVE_KINDS } from "../src/index.js";

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
  it("offers only Bonded's built-in scripted designs", () => {
    expect(SELF_SERVE_KINDS).toEqual(["vulnerable", "partial", "hardened"]);
  });
});
