import { createServer } from "node:net";

/**
 * Preflight checks for the demo's break-it run (`scripts/demo-break.mjs`). A take sends real
 * funds to an attacker and freezes the vault, so it must only start when the breach it causes
 * is certain to be claimable.
 */

/** CoverManager's policy fields the checks read (ICoverManager.Policy). */
export interface PolicyView {
  status: number;
  coveredFrom: bigint;
  endsAt: bigint;
  remainingCover: bigint;
}

/** ICoverManager.Status.Active */
const ACTIVE = 1;

/**
 * Why a breach now would not be paid in full, or undefined if it would. `now` is the chain's
 * latest block timestamp, in seconds. `payout` is what the next take is meant to pay.
 *
 * `activePolicyOf` alone isn't enough: CoverManager sets it at binding, before `coveredFrom` when
 * a waiting period is configured, and an expired policy keeps it until someone accrues it, while
 * ClaimsEngine refuses breaches outside the coverage window.
 */
export function coverageProblem(
  policy: PolicyView,
  now: bigint,
  payout: bigint,
): string | undefined {
  if (policy.status !== ACTIVE) return "the policy is no longer active";
  if (now < policy.coveredFrom)
    return `cover starts at ${isoTime(policy.coveredFrom)} (waiting period)`;
  // A margin, so the breach can't land after the end while the take is still running.
  if (now + 120n >= policy.endsAt) return `the policy ends at ${isoTime(policy.endsAt)}`;
  if (policy.remainingCover < payout)
    return `only ${usd(policy.remainingCover)} of cover is left, less than the ${usd(payout)} payout`;
  return undefined;
}

/**
 * The quote API to use: BONDED_API_URL (from the shell or .env, so read it after loading .env),
 * or the hosted API.
 */
export function quoteApiUrl(env: Record<string, string | undefined>): string {
  return (env.BONDED_API_URL?.trim() || "https://api-production-ba50.up.railway.app").replace(
    /\/+$/,
    "",
  );
}

function isoTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function usd(units: bigint): string {
  return `$${(Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * True if nothing on this machine is listening on `port` (used by `pnpm demo` before it starts
 * anything). Binding every interface isn't enough on its own: macOS allows it while another
 * process holds the port on 127.0.0.1 or ::1, which is where dev servers such as Vite listen. A
 * host this machine doesn't have (no IPv6) is skipped.
 */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of [undefined, "127.0.0.1", "::1"]) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", (e: NodeJS.ErrnoException) =>
        resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"),
      );
      s.listen(port, host, () => s.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}
