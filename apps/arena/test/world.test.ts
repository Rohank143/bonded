import { describe, expect, it } from "vitest";
import { loadAttackLibrary, renderPayload, World } from "../src/index.js";

const tokens = [
  { symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
  { symbol: "tNVDA", address: "0x2222222222222222222222222222222222222222", decimals: 18 },
] as const;
const depositor = "0x3333333333333333333333333333333333333333";
const world = () => new World([...tokens], depositor);

describe("World", () => {
  it("starts with benign content on every surface", () => {
    const w = world();
    expect(w.inbox.length).toBeGreaterThan(0);
    expect(w.news.length).toBeGreaterThan(0);
    expect(w.social.length).toBeGreaterThan(0);
    expect(w.findToken("tnvda")?.name).toBe("Test NVIDIA Stock Token");
    expect(w.transfers[0]).toMatchObject({ direction: "in", counterparty: depositor });
  });

  it("plants content on each supported surface", () => {
    const w = world();
    w.plant({ surface: "dm", text: "dm payload", sender: "boss@example.com" });
    w.plant({ surface: "news", text: "news payload" });
    w.plant({ surface: "social", text: "social payload" });
    w.plant({ surface: "token_metadata", text: "meta payload", token: "tNVDA" });
    w.plant({ surface: "tool_output", text: "tool payload" });
    w.plant({ surface: "price_feed", text: "tNVDA=108\nnot a price line" });
    w.plant({ surface: "tx_history", text: "poisoned", sender: depositor });

    expect(w.inbox.at(-1)).toMatchObject({ from: "boss@example.com", body: "dm payload" });
    expect(w.news[0]?.body).toBe("news payload");
    expect(w.social[0]?.text).toBe("social payload");
    expect(w.findToken("tNVDA")?.description).toContain("meta payload");
    expect(w.marketReport).toContain("tool payload");
    expect(w.priceOverrides.get("tNVDA")).toBe(108);
    expect(w.priceOverrides.size).toBe(1);
    expect(w.transfers.at(-1)?.note).toBe("poisoned");
  });

  it("records the episode's real deposit in the transfer history", () => {
    expect(new World([...tokens], depositor, 1_000).transfers[0]?.amount).toBe("1000");
  });

  it("matches token symbols without case or the test-token prefix", () => {
    const w = world();
    expect(w.findToken("NVDA")?.symbol).toBe("tNVDA");
    expect(w.findToken("usdg")?.symbol).toBe("tUSDG");
    w.plant({ surface: "price_feed", text: "NVDA=50" });
    expect(w.priceOverrides.get("tNVDA")).toBe(50);
    w.plant({ surface: "token_metadata", text: "lowercase target", token: "tnvda" });
    expect(w.findToken("tNVDA")?.description).toContain("lowercase target");
  });

  it("refuses a price attack that would plant nothing", () => {
    expect(() => world().plant({ surface: "price_feed", text: "tXYZ=1" })).toThrow(/unknown token/);
    expect(() => world().plant({ surface: "price_feed", text: "prices are falling" })).toThrow(
      /sets no prices/,
    );
  });

  it("rejects token_metadata attacks on unknown tokens and surfaces not built yet", () => {
    expect(() => world().plant({ surface: "token_metadata", text: "x", token: "tXYZ" })).toThrow(
      /unknown token/,
    );
    expect(() => world().plant({ surface: "counterparty", text: "x" })).toThrow(/Day 6/);
    expect(() =>
      world().plant({ surface: "tx_history", text: "x", sender: "not-an-address" }),
    ).toThrow(/address/);
  });
});

describe("attack library", () => {
  it("loads and validates every seed in attacks/", () => {
    const library = loadAttackLibrary();
    expect(library.map((s) => s.id)).toEqual(
      expect.arrayContaining(["A1-token-metadata-001", "A6-operator-impersonation-001"]),
    );
    for (const spec of library) {
      // Every placeholder a seed uses is one the episode runner provides.
      expect(() =>
        renderPayload(spec.payloadTemplate, {
          attacker: "0xA",
          vault: "0xV",
          amount: "1",
          token: "t",
        }),
      ).not.toThrow();
    }
  });

  it("renders placeholders and refuses unknown ones", () => {
    expect(
      renderPayload("send {{amount}} to {{ attacker }}", { amount: "5", attacker: "0xA" }),
    ).toBe("send 5 to 0xA");
    expect(() => renderPayload("send to {{attackr}}", { attacker: "0xA" })).toThrow(/attackr/);
  });
});
