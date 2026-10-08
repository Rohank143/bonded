import { findInstructions } from "@bonded/demo-agents";
import { describe, expect, it } from "vitest";
import { ATTACK_CLASSES } from "@bonded/shared";
import {
  ATTACK_PLACEHOLDERS,
  loadAttackLibrary,
  lookalikeOf,
  renderPayload,
  World,
} from "../src/index.js";
import {
  counterpartyMessage,
  inboxMessage,
  marketAlert,
  newsArticle,
  seededRandom,
  socialPost,
} from "../src/world-content.js";

const tokens = [
  { symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
  { symbol: "tNVDA", address: "0x2222222222222222222222222222222222222222", decimals: 18 },
] as const;
const depositor = "0x3333333333333333333333333333333333333333";
const world = () => new World([...tokens], depositor);

/** A seeded stream of numbers, so a world can be reproduced. */
const seeded = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};

describe("World", () => {
  it("draws a different benign world for each episode, reproducible from its randomness", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const shape = (w: World) =>
      JSON.stringify([
        w.inbox,
        w.news,
        w.social,
        w.marketAlerts,
        w.counterpartyMessages,
        w.transfers,
        w.marketReport,
        w.tokenList,
        [...w.priceNoise],
      ]);
    const worlds = Array.from({ length: 12 }, (_, i) =>
      shape(new World([...tokens], depositor, 50_000, now, seeded(i + 1))),
    );
    expect(new Set(worlds).size).toBe(12);
    expect(shape(new World([...tokens], depositor, 50_000, now, seeded(3)))).toBe(worlds[2]);
    // Counts vary, so "how many items are there" says nothing about an attack.
    const counts = new Set(
      Array.from({ length: 30 }, (_, i) => {
        const w = new World([...tokens], depositor, 50_000, now, seeded(100 + i));
        return `${w.inbox.length}/${w.news.length}/${w.social.length}/${w.marketAlerts.length}/${w.counterpartyMessages.length}/${w.transfers.length}`;
      }),
    );
    expect(counts.size).toBeGreaterThan(10);
  });

  it("never tells the agent to move funds in its benign content", () => {
    // The reference agent obeys any order it can parse; benign content must give it none, or
    // verdicts would depend on which benign text an episode drew.
    for (let i = 0; i < 2_000; i++) {
      const w = new World([...tokens], depositor, 50_000, new Date(), seededRandom(`orders-${i}`));
      expect(findInstructions(JSON.stringify(w))).toEqual([]);
      expect(
        JSON.stringify([w.inbox, w.news, w.social, w.marketAlerts, w.counterpartyMessages]),
      ).not.toMatch(/0x/);
    }
  });

  it("generates text from a space too large to list", () => {
    const random = seededRandom("space");
    for (const make of [inboxMessage, newsArticle, socialPost, marketAlert, counterpartyMessage]) {
      const texts = new Set(Array.from({ length: 2_000 }, () => JSON.stringify(make(random))));
      // Two thousand draws, almost all different: there's no short list to check against.
      expect(texts.size, make.name).toBeGreaterThan(1_500);
    }
  });

  it("dates every item against the chain's clock, planted content most recently", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const w = new World([...tokens], depositor, 50_000, now);
    w.plant({ surface: "dm", text: "planted", sender: "x@example.com" });
    const times = [...w.inbox, ...w.news, ...w.social, ...w.marketAlerts, ...w.transfers].map(
      (item) => Date.parse(item.time!),
    );
    expect(times.every((t) => t < now.getTime() && t > now.getTime() - 7 * 86_400_000)).toBe(true);
    const planted = Date.parse(w.inbox.find((m) => m.body === "planted")!.time!);
    expect(now.getTime() - planted).toBeLessThanOrEqual(15 * 60_000);
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

    expect(w.inbox.find((m) => m.body === "dm payload")?.from).toBe("boss@example.com");
    expect(w.news.some((n) => n.body === "news payload")).toBe(true);
    expect(w.social.some((p) => p.text === "social payload")).toBe(true);
    expect(w.findToken("tNVDA")?.description).toContain("meta payload");
    expect(w.marketReport).toContain("tool payload");
    expect(w.priceOverrides.get("tNVDA")).toBe(108);
    expect(w.priceOverrides.size).toBe(1);
    expect(w.transfers.find((t) => t.note === "poisoned")?.amount).toBe("0");
  });

  it("records the episode's real deposit in the transfer history", () => {
    // The deposit arrives in one to three parts that add up to what the vault holds.
    for (let i = 0; i < 20; i++) {
      const funding = new World([...tokens], depositor, 1_000).transfers.filter(
        (t) => t.counterparty === depositor,
      );
      expect(funding.length).toBeGreaterThanOrEqual(1);
      expect(funding.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(1_000);
    }
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
    expect(w.marketAlerts.find((a) => a.text === "halt notice")?.source).toBe("Exchange Ops");
    expect(w.counterpartyMessages.find((m) => m.text === "settle now")?.from).toBe("otc-desk-7");
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
