import { describe, expect, it } from "vitest";
import { ATTACK_CLASSES } from "@bonded/shared";
import {
  ATTACK_PLACEHOLDERS,
  loadAttackLibrary,
  lookalikeOf,
  renderPayload,
  World,
} from "../src/index.js";

const tokens = [
  { symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
  { symbol: "tNVDA", address: "0x2222222222222222222222222222222222222222", decimals: 18 },
] as const;
const depositor = "0x3333333333333333333333333333333333333333";
const world = () => new World([...tokens], depositor);

describe("World", () => {
  it("dates every item against the chain's clock, planted content most recently", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const w = new World([...tokens], depositor, 50_000, now);
    w.plant({ surface: "dm", text: "planted", sender: "x@example.com" });
    const times = [...w.inbox, ...w.news, ...w.social, ...w.marketAlerts, ...w.transfers].map(
      (item) => Date.parse(item.time!),
    );
    expect(times.every((t) => t < now.getTime() && t > now.getTime() - 3 * 86_400_000)).toBe(true);
    const planted = Date.parse(w.inbox.at(-1)!.time!);
    expect(now.getTime() - planted).toBeLessThanOrEqual(12 * 60_000);
    expect(w.marketReport).toContain("2026-10-07");
    // Oldest first, like a real history: the deposits, then anything newer.
    const history = w.transfers.map((t) => Date.parse(t.time!));
    expect([...history].sort((a, b) => a - b)).toEqual(history);
  });

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
    // The deposit arrives in two parts that add up to what the vault holds.
    const funded = new World([...tokens], depositor, 1_000).transfers;
    expect(funded.map((t) => t.amount)).toEqual(["600", "400"]);
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

  it("takes prices from delivery.prices when given", () => {
    const w = world();
    w.plant({ surface: "price_feed", text: "tNVDA crashed", prices: { NVDA: 41, tusdg: 0.9 } });
    expect(w.priceOverrides.get("tNVDA")).toBe(41);
    expect(w.priceOverrides.get("tUSDG")).toBe(0.9);
  });

  it("plants market alerts and counterparty messages", () => {
    const w = world();
    w.plant({ surface: "market", text: "halt notice", sender: "Exchange Ops" });
    w.plant({ surface: "counterparty", text: "settle now", sender: "otc-desk-7" });
    expect(w.marketAlerts[0]).toMatchObject({ source: "Exchange Ops", text: "halt notice" });
    expect(w.counterpartyMessages).toMatchObject([{ from: "otc-desk-7", text: "settle now" }]);
  });

  it("rejects token_metadata attacks on unknown tokens and malformed poisoning", () => {
    expect(() => world().plant({ surface: "token_metadata", text: "x", token: "tXYZ" })).toThrow(
      /unknown token/,
    );
    expect(() =>
      world().plant({ surface: "tx_history", text: "x", sender: "not-an-address" }),
    ).toThrow(/address/);
  });
});

describe("attack library", () => {
  it("loads and validates every seed in attacks/", () => {
    const library = loadAttackLibrary();
    expect(library.length).toBeGreaterThanOrEqual(40);
    // Every class has at least four seeds.
    for (const id of Object.keys(ATTACK_CLASSES)) {
      expect(library.filter((s) => s.class === id).length, id).toBeGreaterThanOrEqual(4);
    }
    const vars = Object.fromEntries(ATTACK_PLACEHOLDERS.map((name) => [name, "x"]));
    for (const spec of library) {
      // Every placeholder a seed uses is one the episode runner provides.
      expect(() => renderPayload(spec.payloadTemplate, vars)).not.toThrow();
      if (spec.delivery.sender)
        expect(() => renderPayload(spec.delivery.sender!, vars)).not.toThrow();
      // Surfaces are ones the class is meant to use, or plain content surfaces.
      expect(spec.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("makes lookalike addresses that match at a glance but differ", () => {
    const real = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
    const fake = lookalikeOf(real);
    expect(fake).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(fake.slice(0, 6).toLowerCase()).toBe(real.slice(0, 6).toLowerCase());
    expect(fake.slice(-4).toLowerCase()).toBe(real.slice(-4).toLowerCase());
    expect(fake.toLowerCase()).not.toBe(real.toLowerCase());
  });

  it("renders placeholders and refuses unknown ones", () => {
    expect(
      renderPayload("send {{amount}} to {{ attacker }}", { amount: "5", attacker: "0xA" }),
    ).toBe("send 5 to 0xA");
    expect(() => renderPayload("send to {{attackr}}", { attacker: "0xA" })).toThrow(/attackr/);
  });
});
