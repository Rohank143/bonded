import type { Database } from "@bonded/db";
import {
  Sandbox,
  loadAttackLibrary,
  reasonHash,
  validateBounty,
  type BountyVerdict,
} from "@bonded/arena";
import { AttackSpec, bountyBoardAbi } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { getAbiItem, type Hex } from "viem";

/**
 * Validates revealed bounties (docs/PLAN.md Section 13.1): runs the spec against the reference
 * agents, then the attester accepts (paying the reward from BountyBoard) or rejects on chain. An
 * accepted spec joins the library and every enabled agent on the chain is queued for a fresh
 * rating in the same database transaction, so premiums reprice against the new attack. The
 * verdict is stored before its transaction is sent; a retry reuses it, and a submission already
 * settled on chain is recorded as the chain has it.
 */

/** The library a chain rates against: the repo's seeds plus accepted bounties. */
export async function chainLibrary(db: Database, chainId: number): Promise<AttackSpec[]> {
  const accepted = (await db.acceptedAttacks(chainId)).map((s) => AttackSpec.parse(s));
  return [...loadAttackLibrary(), ...accepted];
}

// BountyBoard.Status: None, Committed, Revealed, Accepted, Rejected.
const REVEALED = 2;
const ACCEPTED = 3;
const REJECTED = 4;

/**
 * Validate one leased bounty. Returns false when none was waiting. Holds the same per-chain lock
 * as rating jobs (worker.ts): both send from the attester key, so they mustn't race for nonces.
 */
export async function workBountyOne(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const chainId = chain.deployment.chainId;
  const lock = await db.pool.connect();
  const locked = (await lock.query("SELECT pg_try_advisory_lock(7004,$1) AS locked", [chainId]))
    .rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    return await workLocked(db, chain, rpcUrl, onError);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(7004,$1)", [chainId]);
    lock.release();
  }
}

async function workLocked(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const chainId = chain.deployment.chainId;
  const job = await db.takeBounty(chainId);
  if (!job) return false;
  // A heartbeat like the rating worker's: an episode can run for minutes and a payout receipt
  // can take longer than the 60-second lease. A lost lease stops the job at its next check.
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    void db.renewBounty(job).catch((e: unknown) => {
      leaseError = e;
    });
  }, 15_000);
  const check = async () => {
    if (leaseError) throw leaseError;
    await db.renewBounty(job);
  };
  try {
    const board = chain.deployment.bountyBoard;
    const id = BigInt(job.submissionId);
    const onChain = await chain.read.readContract({
      address: board,
      abi: bountyBoardAbi,
      functionName: "getSubmission",
      args: [id],
    });
    // Already settled (an earlier attempt sent it, then stopped): the chain decides the status
    // and the reward, and nothing is recomputed against today's library.
    if (onChain.status === ACCEPTED || onChain.status === REJECTED) {
      const accepted = onChain.status === ACCEPTED;
      const stored = job.verdict as BountyVerdict | null;
      const verdict: BountyVerdict = {
        ...(stored ?? {
          reason: "recovered from the chain",
          breaches: { undefended: 0, defended: 0 },
          runs: 0,
          newSurface: false,
        }),
        decision: accepted ? "accept" : "reject",
        reward: onChain.reward.toString(),
      };
      await check();
      await db.finishBounty(job, {
        status: accepted ? "accepted" : "rejected",
        verdict,
        txHash: await settledTransaction(chain, id, accepted),
      });
      return true;
    }
    if (onChain.status !== REVEALED) throw new Error(`submission ${id} isn't revealed on chain`);
    // Decide once. A stored verdict is what was about to be sent; reuse it.
    let verdict = job.verdict as BountyVerdict | null;
    if (!verdict) {
      const spec = AttackSpec.parse(job.spec);
      const library = await chainLibrary(db, chainId);
      const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
      try {
        verdict = await validateBounty(sandbox, spec, library, { onRun: check });
      } finally {
        await sandbox.stop();
      }
      await check();
      await db.recordBountyVerdict(job, verdict);
    }
    await check();
    const txHash =
      verdict.decision === "accept"
        ? await chain.send(board, bountyBoardAbi, "accept", [id, BigInt(verdict.reward)])
        : await chain.send(board, bountyBoardAbi, "reject", [id, reasonHash(verdict.reason)]);
    await db.finishBounty(job, {
      status: verdict.decision === "accept" ? "accepted" : "rejected",
      verdict,
      txHash,
    });
  } catch (error) {
    onError?.(error);
    await db
      .finishBounty(job, { error: "validation failed; retry scheduled" })
      .catch((e: unknown) => onError?.(e));
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

/** The accept or reject transaction an earlier attempt sent, from the board's events. */
async function settledTransaction(
  chain: ServiceChain,
  id: bigint,
  accepted: boolean,
): Promise<Hex> {
  const range = {
    address: chain.deployment.bountyBoard,
    args: { id },
    fromBlock: BigInt(chain.deployment.deployedAtBlock),
    toBlock: "latest",
    strict: true,
  } as const;
  const logs = accepted
    ? await chain.read.getLogs({
        ...range,
        event: getAbiItem({ abi: bountyBoardAbi, name: "Accepted" }),
      })
    : await chain.read.getLogs({
        ...range,
        event: getAbiItem({ abi: bountyBoardAbi, name: "Rejected" }),
      });
  if (!logs[0]) throw new Error(`submission ${id} is settled but its event wasn't found`);
  return logs[0].transactionHash;
}
