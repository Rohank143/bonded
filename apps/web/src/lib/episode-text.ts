import { short } from "./format";

/** Where an attack was planted, as a reader would say it. */
export const SURFACE_LABELS: Record<string, string> = {
  dm: "a direct message",
  news: "a news article",
  social: "a social post",
  token_metadata: "a token's details",
  tool_output: "a market report from a tool",
  price_feed: "the price feed",
  tx_history: "the recent transfers",
  market: "a market alert",
  counterparty: "a message from another agent",
};

/** The tool that shows the agent each surface (apps/arena/src/report.ts, SURFACE_TOOL). */
export const SURFACE_TOOLS: Record<string, string> = {
  dm: "read_inbox",
  news: "read_news",
  social: "read_social",
  token_metadata: "get_token_info",
  tool_output: "get_market_report",
  price_feed: "get_prices",
  tx_history: "get_recent_transfers",
  market: "read_market_alerts",
  counterparty: "read_counterparty_messages",
};

export const BREACH_LABELS: Record<string, string> = {
  T1_UNAUTHORIZED_TARGET: "a contract the mandate doesn't allow",
  T1_UNAUTHORIZED_APPROVAL: "an approval the mandate doesn't allow",
  T1_UNAUTHORIZED_TRANSFER: "a transfer the mandate doesn't allow",
  T1_DEFERRED: "funds taken later through an approval",
  T2_LIMIT: "over a trade or daily limit",
  T3_ASSET: "a token the mandate doesn't allow",
};

const READS: Record<string, string> = {
  read_inbox: "Read its inbox",
  read_news: "Read the news",
  read_social: "Read social posts",
  get_market_report: "Read the market report",
  read_market_alerts: "Read market alerts",
  read_counterparty_messages: "Read messages from other agents",
  get_recent_transfers: "Checked recent transfers",
  get_prices: "Checked prices",
  get_portfolio: "Checked its portfolio",
};

const addr = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? short(v) : (v ?? "?"));
/** "50000" → "50,000"; anything that isn't a plain number is shown as it is. */
const amount = (v?: string) =>
  v && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v).toLocaleString("en-US") : (v ?? "?");
/** A sender that is an address, shortened like every other address in the app. */
export const sender = (v: string) => v.replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a));

/** One step of an episode in words: "Read its inbox", "Sent 5000 tUSDG to 0x84…19". */
export function describeStep(tool: string, args: Record<string, string> = {}): string {
  switch (tool) {
    case "swap":
      return `Swapped ${amount(args.amountIn)} ${args.tokenIn ?? "?"} for ${args.tokenOut ?? "?"}`;
    case "transfer":
      return `Sent ${amount(args.amount)} ${args.token ?? "?"} to ${addr(args.to)}`;
    case "approve":
      return `Let ${addr(args.spender)} spend ${args.amount ? `${amount(args.amount)} ` : ""}${args.token ?? "?"}`;
    case "get_token_info":
      return `Looked up ${args.symbol ?? "a token"}`;
    default:
      return READS[tool] ?? tool.replaceAll("_", " ");
  }
}

/** The same action, as something the agent tried but its guard stopped. */
export function describeAttempt(tool: string, args: Record<string, string> = {}): string {
  const done = describeStep(tool, args);
  return done
    .replace(/^Swapped/, "Swap")
    .replace(/^Sent/, "Send")
    .replace(/^Let/, "Let")
    .replace(/^Looked up/, "Look up");
}
