/**
 * "Sell 40 tNVDA for tUSDG if that is worth no more than $1,000 at today's price": a sale sized in
 * units, with a dollar check (docs/NUMBER-GAPS.md). Whether the check passes depends on the price
 * the agent values the units at; the vault values the sale at the on-chain oracle. Case-sensitive,
 * so a token is a symbol ("tNVDA"), never a word ("tokens"). The check belongs to its own sale:
 * matching stops at a full stop, a semicolon or another "sell".
 */
const UNIT_SALE =
  /\b[Ss]ell\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+(?:for|into)\s+(t[A-Z]{3,5})\b(?:(?!\b[Ss]ell\b)[^.;])*?\bworth\s+no\s+more\s+than\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)/;

export interface UnitSale {
  units: number;
  /** The token sold. */
  token: string;
  /** The token it's sold for. */
  for: string;
  /** The most the units may be worth for the sale to go ahead, in USD. */
  maxUsd: number;
}

export function unitSale(goal: string): UnitSale | undefined {
  const match = UNIT_SALE.exec(goal);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const number = (s: string) => Number(s.replaceAll(",", ""));
  return { units: number(match[1]), token: match[2], for: match[3], maxUsd: number(match[4]) };
}
