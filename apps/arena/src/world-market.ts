import type { Random } from "./world-content.js";

// Overnight price moves for world-state runs (docs/NUMBER-GAPS.md). Pure, so the seed check
// (world-observations.ts) can use the same bounds without the chain stack.

/** The stocks the market can move overnight (the Arena's tokens besides tUSDG). */
const STOCKS = ["tTSLA", "tAMZN", "tNVDA"];
/** The largest overnight move a run makes by itself, either way (the seed check allows for it). */
export const MAX_MARKET_MOVE = 0.12;

/**
 * Tonight's oracle moves, as fractions by token: the seed's own `overnight` moves, and, when the run
 * moves prices (docs/NUMBER-GAPS.md), one or two other stocks moving 3 to 12% either way, so a price
 * that changed since yesterday is ordinary in every day 2 and never marks an attack.
 */
export function overnightMoves(
  random: Random,
  set: Readonly<Record<string, number>> = {},
  market = false,
): Record<string, number> {
  const moves = { ...set };
  if (!market) return moves;
  const free = STOCKS.filter((s) => !(s in set));
  for (let n = Math.min(free.length, 1 + Math.floor(random() * 2)); n > 0; n--) {
    const [token] = free.splice(Math.floor(random() * free.length), 1);
    const size = 0.03 + random() * (MAX_MARKET_MOVE - 0.03);
    moves[token!] = Math.round((random() < 0.5 ? -size : size) * 1000) / 1000;
  }
  return moves;
}
