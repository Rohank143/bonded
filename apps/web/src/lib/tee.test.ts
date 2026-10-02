import { describe, expect, it } from "vitest";
import type { Report } from "./api";
import { liveCheckView, teeView } from "./tee";

const M = `0x${"ab".repeat(32)}` as const;
const ZERO = `0x${"00".repeat(32)}`;
const report = (measurement: string) =>
  ({
    tee: {
      measurement,
      composeHash: `0x${"cd".repeat(32)}`,
      evmAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      solanaPublicKey: "11111111111111111111111111111112",
      tcbStatus: "UpToDate",
    },
  }) as unknown as Report;

describe("teeView", () => {
  it("shows no badge when the registry has no measurement", () => {
    expect(teeView(ZERO, report(M))).toEqual({ inTee: false, measurement: null, keys: null });
    expect(teeView(undefined, undefined)).toEqual({ inTee: false, measurement: null, keys: null });
    expect(teeView("0x12", null).inTee).toBe(false);
  });

  it("shows the badge from the on-chain measurement alone", () => {
    expect(teeView(M, null)).toEqual({ inTee: true, measurement: M, keys: null });
  });

  it("shows the keys only when the report's measurement is the on-chain one", () => {
    expect(teeView(M, report(M.toUpperCase().replace("0X", "0x"))).keys).toEqual({
      evm: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      solana: "11111111111111111111111111111112",
    });
    expect(teeView(M, report(`0x${"ee".repeat(32)}`)).keys).toBeNull();
  });

  it("does not trust a report that claims a TEE when the registry says none", () => {
    expect(teeView(ZERO, report(M)).inTee).toBe(false);
  });

  it("handles a report from before TEE support", () => {
    expect(teeView(M, {} as Report).keys).toBeNull();
  });
});

describe("liveCheckView", () => {
  it("is red only for a definite failure", () => {
    expect(liveCheckView("mismatch").tone).toBe("breach");
    expect(liveCheckView("invalid").tone).toBe("breach");
    for (const status of ["unreachable", "unrated", undefined])
      expect(liveCheckView(status).tone).toBe("neutral");
    expect(liveCheckView("verified").tone).toBe("safe");
  });

  it("keeps an outstanding failure red while the agent is offline", () => {
    expect(liveCheckView("unreachable", "mismatch")).toMatchObject({
      label: "changed",
      tone: "breach",
    });
    expect(liveCheckView("unreachable", "invalid").label).toBe("failed");
    expect(liveCheckView("unreachable", null).label).toBe("offline");
    expect(liveCheckView("verified", null).tone).toBe("safe");
  });

  it("says new cover is paused when it is", () => {
    expect(liveCheckView("mismatch").hint).toMatch(/new cover is paused/);
    expect(liveCheckView("unreachable").hint).not.toMatch(/paused/);
  });
});
