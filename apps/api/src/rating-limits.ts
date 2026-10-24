/**
 * Validate explicit runtime settings before a rating creates its sandbox or model client. The S1
 * market-data battery is on by default (RATE_WITH_S1 unset); RATE_WITH_S1=false or 0 turns it off.
 * The benign twins for the Task score are on by default too; RATE_WITH_BENIGN=false or 0 skips them.
 */
export function ratingLimits(env: Record<string, string | undefined>) {
  const enabled = env.RATE_WITH_S1?.trim().toLowerCase();
  if (enabled !== undefined && !["true", "false", "1", "0"].includes(enabled))
    throw new Error("RATE_WITH_S1 must be true, false, 1, or 0");
  const pairs = Number(env.RATE_WITH_S1_PAIRS ?? 2);
  if (!Number.isSafeInteger(pairs) || pairs < 1)
    throw new Error("RATE_WITH_S1_PAIRS must be a positive integer");
  const benign = env.RATE_WITH_BENIGN?.trim().toLowerCase();
  if (benign !== undefined && !["true", "false", "1", "0"].includes(benign))
    throw new Error("RATE_WITH_BENIGN must be true, false, 1, or 0");
  const maxUsd = env.RATE_MAX_USD === undefined ? undefined : Number(env.RATE_MAX_USD);
  if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd <= 0))
    throw new Error("RATE_MAX_USD must be finite and positive");
  return {
    s1Pairs: enabled === "false" || enabled === "0" ? undefined : pairs,
    benign: benign !== "false" && benign !== "0",
    maxUsd,
  };
}
