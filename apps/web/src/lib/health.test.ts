import { afterEach, describe, expect, it } from "vitest";
import {
  gasNotice,
  jobAge,
  markInboxSeen,
  overallStatus,
  scoreLine,
  unreadCount,
  vaultTradingLine,
  type ServiceStatus,
} from "./health";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
afterEach(() => localStorage.clear());

describe("health lines", () => {
  it("says whether the agent trades through its vault", () => {
    expect(vaultTradingLine(null, NOW).tone).toBe("neutral");
    expect(
      vaultTradingLine(
        { firstTradeAt: null, lastTradeAt: null, trades24h: 0, lastTxHash: null },
        NOW,
      ),
    ).toMatchObject({
      tone: "warn",
      text: expect.stringMatching(/No trade through the vault yet/),
    });
    expect(
      vaultTradingLine(
        { firstTradeAt: iso(-9e8), lastTradeAt: iso(-3_600_000), trades24h: 4, lastTxHash: "0x1" },
        NOW,
      ),
    ).toEqual({
      text: "Last trade through the vault 1h ago; 4 trades in the last 24 hours.",
      tone: "safe",
    });
    expect(
      vaultTradingLine(
        {
          firstTradeAt: iso(-9e9),
          lastTradeAt: iso(-8 * 86_400_000),
          trades24h: 0,
          lastTxHash: "0x1",
        },
        NOW,
      ).tone,
    ).toBe("warn");
  });

  it("warns on low gas only when the API says it's low", () => {
    expect(gasNotice({ balance: "1000000000000000", low: false })).toBeUndefined();
    expect(gasNotice({ balance: "200000000000000", low: true, estimatedTradesLeft: 3 })).toBe(
      "Your agent's key is low on gas: it has 0.0002 ETH, and it pays the gas for every trade through the vault. That's enough for about 3 more trades.",
    );
  });

  it("reads the score's expiry", () => {
    const s = (days: number, valid = true) => ({
      value: 72,
      tier: "A",
      expiresAt: iso(days * 86_400_000),
      valid,
    });
    expect(scoreLine(null, NOW).text).toBe("Not rated yet");
    expect(scoreLine(s(20), NOW)).toEqual({
      text: "Score 72 (A), valid for 20 more days",
      tone: "safe",
    });
    expect(scoreLine(s(3), NOW)).toEqual({ text: "Score 72 (A) expires in 3 days", tone: "warn" });
    expect(scoreLine(s(-1, false), NOW).tone).toBe("breach");
  });

  it("counts unread notifications by the API's flag, or since the last visit", () => {
    const items = [
      { id: "1", kind: "low-gas", message: "a", createdAt: iso(-1000) },
      { id: "2", kind: "low-gas", message: "b", createdAt: iso(-1e7) },
      { id: "3", kind: "low-gas", message: "c", createdAt: iso(-10), read: true },
    ];
    expect(unreadCount(items, NOW - 60_000)).toBe(1);
    markInboxSeen(NOW);
    expect(unreadCount(items)).toBe(0);
  });

  it("sums the service status up", () => {
    const ok: ServiceStatus = {
      gateway: { up: true },
      lanes: {
        check: { healthy: true, lastJobAgeSeconds: 30 },
        remote: { healthy: true, lastJobAgeSeconds: 600 },
      },
      previewQueue: 0,
      version: "abc",
      checkedAt: iso(0),
    };
    expect(overallStatus(ok, false).label).toBe("All systems normal");
    expect(overallStatus({ ...ok, gateway: { up: false } }, false).tone).toBe("breach");
    expect(
      overallStatus(
        { ...ok, lanes: { ...ok.lanes, remote: { healthy: false, lastJobAgeSeconds: null } } },
        false,
      ).tone,
    ).toBe("warn");
    expect(overallStatus(undefined, true).label).toBe("Status unknown");
    expect(jobAge(null)).toBe("no job yet");
    expect(jobAge(600)).toBe("10 min ago");
  });
});
