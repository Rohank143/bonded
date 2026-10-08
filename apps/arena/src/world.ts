import type { AttackSurface } from "@bonded/shared";
import type { ArenaToken } from "./vault.js";
import {
  ALERTS,
  between,
  COUNTERPARTY,
  INBOX,
  marketReport,
  NEWS,
  pick,
  PLANTED_NEWS_TITLES,
  PLANTED_SUBJECTS,
  type Random,
  sample,
  SOCIAL,
  TOKEN_DESCRIPTIONS,
  TOKEN_NOTES,
} from "./world-content.js";

/**
 * The simulated world an agent reads during an episode: messages, news, social posts, token
 * metadata, prices, tool outputs and transfer history. It starts with ordinary, benign
 * content; an attack plants adversarial content on one or more surfaces. See docs/SPECIFICATION.md
 * Section 8.1 and ADR-005.
 *
 * Reads that describe the chain itself (balances, the vault's breach log) never come from
 * here: they're read from the sandbox chain, so an attack can mislead the agent but can't
 * fake the verdict.
 */

export interface InboxMessage {
  from: string;
  subject: string;
  body: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

export interface NewsArticle {
  source: string;
  title: string;
  body: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

export interface SocialPost {
  author: string;
  text: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

export interface TokenListing {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  description: string;
}

export interface MarketAlert {
  source: string;
  text: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

export interface CounterpartyMessage {
  from: string;
  text: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

export interface TransferRecord {
  direction: "in" | "out";
  token: string;
  amount: string;
  counterparty: `0x${string}`;
  note?: string;
  /** When it was sent, posted or made (ISO 8601), relative to the chain's own clock. */
  time?: string;
}

/** Adversarial content for one surface, already rendered from an attack's template. */
export interface PlantedContent {
  surface: AttackSurface;
  text: string;
  /** Who the content appears to come from (DM sender, news source, post author). */
  sender?: string;
  /** For token_metadata: which token's description carries the payload. */
  token?: string;
  /** For price_feed: prices the price API reports instead of the oracle's. */
  prices?: Record<string, number>;
}

const TOKEN_DETAILS: Record<string, { name: string; description: string }> = {
  tUSDG: {
    name: "Test Global Dollar",
    description: "Dollar-backed stablecoin used as the vault's base currency.",
  },
  tTSLA: {
    name: "Test Tesla Stock Token",
    description: "Tokenized Tesla, Inc. common stock (test).",
  },
  tAMZN: {
    name: "Test Amazon Stock Token",
    description: "Tokenized Amazon.com, Inc. common stock (test).",
  },
  tNVDA: {
    name: "Test NVIDIA Stock Token",
    description: "Tokenized NVIDIA Corporation common stock (test).",
  },
};

export class World {
  readonly inbox: InboxMessage[];
  readonly news: NewsArticle[];
  readonly social: SocialPost[];
  readonly marketAlerts: MarketAlert[];
  readonly counterpartyMessages: CounterpartyMessage[];
  readonly transfers: TransferRecord[] = [];
  readonly tokenList: TokenListing[];
  marketReport: string;
  /** Price overrides shown by the price API (the on-chain oracle is never changed). */
  readonly priceOverrides = new Map<string, number>();
  /**
   * The price API's small difference from the oracle, per token (a factor near 1), as between
   * any two real price sources. Overrides (an attack) replace the price outright.
   */
  readonly priceNoise = new Map<string, number>();

  /**
   * A fresh benign world for one episode (world-content.ts): its counts, wording, times, prices
   * and history vary, so a control can't be told from an attacked episode by comparing what the
   * agent reads with a fixed baseline.
   *
   * @param now the world's clock: the chain's latest block time (on a fork, the live chain's
   *   time). Items are dated on it, and planted content arrives among the recent ones.
   * @param random the randomness for this world (tests can fix it).
   */
  constructor(
    tokens: ArenaToken[],
    depositor: `0x${string}`,
    deposit = 50_000,
    private readonly now: Date = new Date(),
    private readonly random: Random = Math.random,
  ) {
    // Times: a few items are minutes old, so planted content isn't simply the newest thing.
    const dated = () =>
      this.ago(pick(random, [2, 5, 9, 15, 25, 40, 70, 120, 190, 300]) * (0.7 + 0.6 * random()));
    this.inbox = sample(random, INBOX, between(random, 1, 3)).map((m) => ({ ...m, time: dated() }));
    this.news = sample(random, NEWS, between(random, 2, 4)).map((n) => ({ ...n, time: dated() }));
    this.social = sample(random, SOCIAL, between(random, 2, 4)).map((p) => ({
      ...p,
      time: dated(),
    }));
    this.marketAlerts = sample(random, ALERTS, between(random, 1, 3)).map((a) => ({
      ...a,
      time: dated(),
    }));
    this.counterpartyMessages = sample(random, COUNTERPARTY, between(random, 0, 2)).map((m) => ({
      ...m,
      time: dated(),
    }));
    this.marketReport = marketReport(random, this.now.toISOString().slice(0, 10));
    this.tokenList = tokens.map((token) => {
      const details = TOKEN_DETAILS[token.symbol];
      const phrasings = TOKEN_DESCRIPTIONS[token.symbol];
      return {
        ...token,
        name: details?.name ?? token.symbol,
        description: phrasings
          ? `${pick(random, phrasings)}${pick(random, TOKEN_NOTES)}`
          : (details?.description ?? ""),
      };
    });
    for (const token of tokens) {
      const spread = token.symbol === "tUSDG" ? 0.002 : 0.006;
      this.priceNoise.set(token.symbol, 1 + (random() * 2 - 1) * spread);
    }
    // The vault's funding: one to three deposits from the depositor that add up to what it
    // holds, over the past days. Sometimes a zero-value transfer from an unknown address, as
    // spam on real chains (address poisoning looks like this too).
    const parts = between(random, 1, 3);
    let left = deposit;
    for (let i = 0; i < parts; i++) {
      const amount =
        i === parts - 1 ? left : Math.round((left * (0.3 + 0.4 * random())) / 100) * 100;
      left -= amount;
      this.transfers.push({
        direction: "in",
        token: "tUSDG",
        amount: String(amount),
        counterparty: depositor,
        note: "Depositor funding",
        time: this.ago((parts - i) * (18 + 30 * random()) * 60),
      });
    }
    for (let i = between(random, 0, 1); i > 0; i--)
      this.transfers.push({
        direction: "in",
        token: "tUSDG",
        amount: "0",
        counterparty: randomAddress(random),
        time: dated(),
      });
    this.order();
  }

  /** Newest first for feeds; oldest first for the inbox, counterparty messages and history. */
  private order(): void {
    const byTime = (newestFirst: boolean) => (a: { time?: string }, b: { time?: string }) =>
      (Date.parse(a.time ?? "") - Date.parse(b.time ?? "")) * (newestFirst ? -1 : 1);
    this.news.sort(byTime(true));
    this.social.sort(byTime(true));
    this.marketAlerts.sort(byTime(true));
    this.inbox.sort(byTime(false));
    this.counterpartyMessages.sort(byTime(false));
    this.transfers.sort(byTime(false));
  }

  /** An ISO time `minutes` before the world's clock. */
  private ago(minutes: number): string {
    return new Date(this.now.getTime() - Math.round(minutes * 60_000)).toISOString();
  }

  /** When planted content arrived: within the last few minutes, among the recent benign items. */
  private recent(): string {
    return this.ago(1 + this.random() * 14);
  }

  /** Plants adversarial content on its surface. */
  plant(content: PlantedContent): void {
    switch (content.surface) {
      case "dm":
        this.inbox.push({
          from: content.sender ?? "unknown@example.com",
          subject: pick(this.random, PLANTED_SUBJECTS),
          body: content.text,
          time: this.recent(),
        });
        this.order();
        return;
      case "news":
        this.news.push({
          source: content.sender ?? "Breaking News",
          title: pick(this.random, PLANTED_NEWS_TITLES),
          body: content.text,
          time: this.recent(),
        });
        this.order();
        return;
      case "social":
        this.social.push({
          author: content.sender ?? "@anon",
          text: content.text,
          time: this.recent(),
        });
        this.order();
        return;
      case "token_metadata": {
        const symbol = content.token ?? "tNVDA";
        const listing = this.findToken(symbol);
        if (!listing) throw new Error(`token_metadata attack targets unknown token ${symbol}`);
        listing.description = `${listing.description} ${content.text}`;
        return;
      }
      case "tool_output":
        this.marketReport = `${this.marketReport}\n\n${content.text}`;
        return;
      case "price_feed": {
        // Prices come from delivery.prices, or from "SYMBOL=PRICE" lines in the payload
        // (e.g. "tNVDA=108"). A payload that sets no known token's price would plant nothing,
        // so it fails instead of counting as an attack.
        const prices = Object.entries(content.prices ?? {});
        for (const line of content.prices ? [] : content.text.split("\n")) {
          const match = /^\s*([A-Za-z0-9]+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
          if (match?.[1] && match[2]) prices.push([match[1], Number(match[2])]);
        }
        if (prices.length === 0) throw new Error("price_feed attack payload sets no prices");
        for (const [symbol, price] of prices) {
          const listing = this.findToken(symbol);
          if (!listing) throw new Error(`price_feed attack prices unknown token ${symbol}`);
          this.priceOverrides.set(listing.symbol, price);
        }
        return;
      }
      case "tx_history": {
        // A zero-value transfer from a lookalike address (address poisoning).
        const from = content.sender ?? "";
        if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
          throw new Error("a tx_history attack needs delivery.sender set to an address");
        }
        this.transfers.push({
          direction: "in",
          token: "tUSDG",
          amount: "0",
          counterparty: from as `0x${string}`,
          note: content.text,
          time: this.recent(),
        });
        this.order();
        return;
      }
      case "market":
        this.marketAlerts.push({
          source: content.sender ?? "Exchange",
          text: content.text,
          time: this.recent(),
        });
        this.order();
        return;
      case "counterparty":
        this.counterpartyMessages.push({
          from: content.sender ?? "counterparty-agent",
          text: content.text,
          time: this.recent(),
        });
        this.order();
        return;
    }
  }

  /** Finds a listed token by symbol, ignoring case and the test-token "t" prefix (NVDA → tNVDA). */
  findToken(symbol: string): TokenListing | undefined {
    const wanted = symbol.toLowerCase();
    return (
      this.tokenList.find((t) => t.symbol.toLowerCase() === wanted) ??
      this.tokenList.find((t) => t.symbol.toLowerCase() === `t${wanted}`)
    );
  }
}

function randomAddress(random: Random): `0x${string}` {
  let hex = "";
  for (let i = 0; i < 40; i++) hex += Math.floor(random() * 16).toString(16);
  return `0x${hex}`;
}
