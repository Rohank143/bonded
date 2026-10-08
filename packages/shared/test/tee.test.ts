import { describe, expect, it } from "vitest";
import {
  isTeeMeasurement,
  TeeEvidence,
  teeMeasurement,
  teeReportData,
  ZERO_BYTES32,
} from "../src/index.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const long = (n: number) => n.toString(16).padStart(96, "0");
const measured = {
  mrTd: long(1),
  rtMr0: long(2),
  rtMr1: long(3),
  rtMr2: long(4),
  composeHash: hash(5).slice(2),
};
const binding = {
  codeHash: hash(7),
  evmAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
  solanaPublicKey: "11111111111111111111111111111112",
  nonce: hash(9),
};

describe("teeMeasurement", () => {
  it("is a stable 32-byte hash", () => {
    const m = teeMeasurement(measured);
    expect(m).toMatch(/^0x[0-9a-f]{64}$/);
    expect(teeMeasurement({ ...measured })).toBe(m);
    expect(isTeeMeasurement(m)).toBe(true);
  });

  it("ignores hex prefix and case", () => {
    expect(
      teeMeasurement({ ...measured, mrTd: `0x${long(1).toUpperCase()}`, composeHash: hash(5) }),
    ).toBe(teeMeasurement(measured));
  });

  it("changes when any measured part changes", () => {
    const base = teeMeasurement(measured);
    for (const key of ["mrTd", "rtMr0", "rtMr1", "rtMr2"] as const)
      expect(teeMeasurement({ ...measured, [key]: long(99) })).not.toBe(base);
    expect(teeMeasurement({ ...measured, composeHash: hash(6).slice(2) })).not.toBe(base);
  });

  it("treats the zero hash as no measurement", () => {
    expect(isTeeMeasurement(ZERO_BYTES32)).toBe(false);
    expect(isTeeMeasurement("0x12")).toBe(false);
  });
});

describe("teeReportData", () => {
  it("binds an EVM-only agent (no Solana key) to something no keyed agent can produce", () => {
    const evmOnly = { ...binding, solanaPublicKey: undefined };
    expect(teeReportData(evmOnly)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(teeReportData(evmOnly)).not.toBe(teeReportData(binding));
    expect(TeeEvidence.shape.solanaPublicKey.safeParse(undefined).success).toBe(true);
    expect(TeeEvidence.shape.solanaPublicKey.safeParse("").success).toBe(false);
  });

  it("binds the code, both keys and the nonce", () => {
    const base = teeReportData(binding);
    expect(teeReportData({ ...binding })).toBe(base);
    expect(teeReportData({ ...binding, codeHash: hash(8) })).not.toBe(base);
    expect(
      teeReportData({ ...binding, evmAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }),
    ).not.toBe(base);
    expect(
      teeReportData({ ...binding, solanaPublicKey: "11111111111111111111111111111113" }),
    ).not.toBe(base);
    expect(teeReportData({ ...binding, nonce: hash(10) })).not.toBe(base);
  });

  it("accepts a nonce with or without the 0x prefix", () => {
    expect(teeReportData({ ...binding, nonce: binding.nonce.slice(2) })).toBe(
      teeReportData(binding),
    );
  });
});

describe("TeeEvidence", () => {
  const evidence = {
    quote: "0xabcd",
    eventLog: "[]",
    composeHash: hash(5).slice(2),
    codeHash: hash(7),
    evmAddress: binding.evmAddress,
    solanaPublicKey: binding.solanaPublicKey,
    nonce: hash(9),
  };

  it("parses a well-formed response", () => {
    expect(TeeEvidence.parse(evidence).codeHash).toBe(hash(7));
  });

  it("rejects extra fields and malformed values", () => {
    expect(() => TeeEvidence.parse({ ...evidence, extra: 1 })).toThrow();
    expect(() => TeeEvidence.parse({ ...evidence, composeHash: "0x12" })).toThrow();
    expect(() => TeeEvidence.parse({ ...evidence, solanaPublicKey: "not base58!" })).toThrow();
    expect(() => TeeEvidence.parse({ ...evidence, quote: "zz" })).toThrow();
  });
});
