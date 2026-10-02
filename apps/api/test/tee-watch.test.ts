import { TeeUnavailableError, TeeVerificationError, type VerifiedTee } from "@bonded/arena";
import { describe, expect, it } from "vitest";
import { type Attest, checkAgentTee, QUOTE_BLOCKING } from "../src/tee-watch.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const RATED = hash(5);
const ZERO = hash(0);
const tee = { url: "https://agent.example", composeHash: hash(9) };
const live = (measurement: string) =>
  (async () => ({ measurement }) as unknown as VerifiedTee) as Attest;
const fails =
  (error: Error): Attest =>
  async () => {
    throw error;
  };
const check = (attest: Attest, rated: string = RATED) => checkAgentTee(tee, hash(7), rated, attest);

describe("checkAgentTee", () => {
  it("verifies when the live measurement is the rated one, ignoring case", async () => {
    expect(await check(live(RATED))).toEqual({ status: "verified", measurement: RATED });
    expect((await check(live(RATED.toUpperCase().replace("0X", "0x")))).status).toBe("verified");
  });

  it("flags a verified quote whose measurement is not the rated one", async () => {
    const result = await check(live(hash(6)));
    expect(result).toMatchObject({ status: "mismatch", measurement: hash(6) });
  });

  it("calls it unrated when the score has no TEE measurement yet", async () => {
    expect(await check(live(hash(6)), ZERO)).toEqual({ status: "unrated", measurement: hash(6) });
  });

  it("calls a failed verification invalid, with the reason", async () => {
    const result = await check(fails(new TeeVerificationError("the quote is malformed")));
    expect(result).toEqual({ status: "invalid", detail: "the quote is malformed" });
  });

  it("calls an agent or Intel data that can't be reached unreachable", async () => {
    const result = await check(fails(new TeeUnavailableError("the TEE agent answered 502")));
    expect(result).toEqual({ status: "unreachable", detail: "the TEE agent answered 502" });
    expect((await check(fails(new Error("boom")))).status).toBe("unreachable");
  });

  it("passes the agent's code hash and compose hash to the verifier", async () => {
    let seen: unknown;
    await check(async (options) => {
      seen = options;
      return { measurement: RATED } as unknown as VerifiedTee;
    });
    expect(seen).toEqual({ url: tee.url, codeHash: hash(7), composeHash: tee.composeHash });
  });
});

describe("what stops quotes", () => {
  it("is only a definite failure, never an unreachable or unrated agent", () => {
    expect([...QUOTE_BLOCKING].sort()).toEqual(["invalid", "mismatch"]);
  });
});
