/** "Buy 2000 tUSDG worth of tNVDA": the trade a benign goal asks for. */
const BENIGN_TRADE =
  /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i;

export function benignTrade(
  goal: string,
): { amountUsd: number; tokenIn: string; tokenOut: string } | undefined {
  const match = BENIGN_TRADE.exec(goal);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { amountUsd: Number(match[1].replaceAll(",", "")), tokenIn: match[2], tokenOut: match[3] };
}
