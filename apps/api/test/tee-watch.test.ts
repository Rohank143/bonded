import { TeeUnavailableError, TeeVerificationError, type VerifiedTee } from "@bonded/arena";
import { describe, expect, it } from "vitest";
import type { TeeCheckRow } from "@bonded/db";
import { type Attest, checkAgentTee, QUOTE_BLOCKING, teeQuoteBlock } from "../src/tee-watch.js";

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

  it("flags a verified TEE whose key is not the one recorded for the rating", async () => {
    const attest = (async () => ({
      measurement: RATED,
      evmAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    })) as unknown as Attest;
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const swapped = await checkAgentTee(tee, hash(7), RATED, attest, other);
    expect(swapped).toMatchObject({ status: "mismatch" });
    expect(swapped.detail).toMatch(/key/);
    const same = await checkAgentTee(
      tee,
      hash(7),
      RATED,
      attest,
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    );
    expect(same.status).toBe("verified");
    expect(same.evmAddress).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
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
  });

  it("calls anything else that goes wrong with evidence a failure, never an outage", async () => {
    // A hostile agent must not be able to make itself "unreachable" and so keep getting quotes.
    const result = await check(fails(new TypeError("Cannot read properties of null")));
    expect(result).toEqual({ status: "invalid", detail: "the check failed unexpectedly" });
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

describe("teeQuoteBlock", () => {
  const KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const row = (over: Partial<TeeCheckRow> = {}): TeeCheckRow => ({
    status: "verified",
    detail: null,
    measurement: RATED,
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
    evmAddress: KEY,
    blockingStatus: null,
    checkedAt: new Date(),
    verifiedAt: new Date(),
    ...over,
  });
  const block = (r: TeeCheckRow | undefined, vaultAgent = KEY, onchain = RATED) =>
    teeQuoteBlock({ onchainMeasurement: onchain, onchainReportHash: hash(1), vaultAgent, row: r });

  it("ignores everything for an agent with no TEE measurement", () => {
    expect(block(undefined, KEY, ZERO)).toBeUndefined();
    expect(block(row({ blockingStatus: "invalid", evmAddress: null }), KEY, ZERO)).toBeUndefined();
  });

  it("allows a vault run by the TEE's key with no failure, ignoring address case", () => {
    expect(block(row())).toBeUndefined();
    expect(block(row(), KEY.toLowerCase())).toBeUndefined();
  });

  it("refuses when the key isn't on record for this very score", () => {
    expect(block(undefined)).toMatch(/not on record/);
    expect(block(row({ evmAddress: null }))).toMatch(/not on record/);
    expect(block(row({ ratedMeasurement: hash(6) }))).toMatch(/not on record/);
    expect(block(row({ ratedReportHash: hash(2) }))).toMatch(/not on record/);
  });

  it("refuses when the vault's execution key is not the TEE's key, including after a rotation", () => {
    expect(block(row(), "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")).toMatch(
      /execution key is not the TEE agent's attested key/,
    );
  });

  it("refuses on an outstanding definite failure, and not on an outage", () => {
    for (const blockingStatus of ["mismatch", "invalid"])
      expect(block(row({ blockingStatus }))).toMatch(/no longer matches/);
    expect(block(row({ status: "unreachable", blockingStatus: null }))).toBeUndefined();
  });
});
