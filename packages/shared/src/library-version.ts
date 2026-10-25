/**
 * The attack library version: one number for everything a rating is measured against — the
 * published attacks (`attacks/`), the S1 market-data seeds (`apps/arena/s1-seeds`), the memory
 * seeds (`apps/arena/s1-seeds-memory`) and the scoring rules (`susceptibility()` and
 * `scoreRating()` in actuarial.ts, the S1 and memory counting rules). Every rating report and
 * leaderboard entry records it, so a result measured against older attacks or rules is shown as
 * such instead of as current.
 *
 * Bump it by hand, in the same commit, whenever a seed is added, removed or changed, or a scoring
 * rule changes what a rating would produce. A test in apps/arena (library-version.test.ts) fails
 * when the seeds change without a bump. Bumping it never touches the chain: the version lives in
 * the report, which the attestation commits to through `reportHash` (docs/SCORING.md).
 *
 * History:
 * - 1 (2026-10-19): the ten-class library with held-out variants, the S1 market-data battery and
 *   the memory battery, as used for the Oct 19–20 leaderboard re-rating.
 */
export const ATTACK_LIBRARY_VERSION = 1;

/**
 * The Task score version: one number for what the Task score is measured against — the benign
 * twins (`apps/arena/benign-seeds`) and `taskScore()` in apps/arena. Kept apart from
 * ATTACK_LIBRARY_VERSION, so the twins can change without marking every security grade as
 * older: they never enter the security grade or the insurance score. Bump it in the same commit
 * when a twin is added, removed or changed, or the Task score's rule changes; a test in apps/arena
 * (library-version.test.ts) fingerprints the twins.
 *
 * History:
 * - 1 (2026-10-25): eleven benign twins (at least one per attack class), the lowest graded part
 *   of controls, unbreached attack episodes and twins, at least five trials a part.
 * - 2 (2026-10-25): five harder twins (sixteen in all), tagged `hard`: a real order next to a
 *   lookalike sender's, a queue replaced by a later one, news against a social post, a fall in
 *   percent rather than dollars, and a halt that has been lifted. Every rated agent scored 100
 *   on version 1's model-driven entries, so it didn't tell good agents apart.
 */
export const TASK_SCORE_VERSION = 2;

/**
 * How a recorded version compares with the current one: `current`, `older` (rated on a previous
 * library, so not comparable with current results), or `unversioned` (rated before versions were
 * recorded).
 */
export function libraryVersionStatus(
  version: number | undefined,
): "current" | "older" | "unversioned" {
  if (version === undefined) return "unversioned";
  return version >= ATTACK_LIBRARY_VERSION ? "current" : "older";
}
