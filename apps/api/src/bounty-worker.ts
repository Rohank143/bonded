import type { BountyJob, Database } from "@bonded/db";
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
 * rating, so premiums reprice against the new attack.
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
  try {
    const spec = AttackSpec.parse(job.spec);
    const library = await chainLibrary(db, chainId);
    const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
    let verdict: BountyVerdict;
    try {
      verdict = await validateBounty(sandbox, spec, library, { onRun: () => db.renewBounty(job) });
    } finally {
      await sandbox.stop();
    }
    await db.renewBounty(job);
    const txHash = await settle(chain, job, verdict);
    await db.finishBounty(job, {
      status: verdict.decision === "accept" ? "accepted" : "rejected",
      verdict,
      txHash,
    });
    if (verdict.decision === "accept") await db.enqueueAll(chainId);
  } catch (error) {
    onError?.(error);
    await db
      .finishBounty(job, { error: "validation failed; retry scheduled" })
      .catch((e: unknown) => onError?.(e));
  }
  return true;
}

/**
 * Send accept or reject, unless an earlier attempt already did: a retry recovers that
 * transaction from the board's events instead of sending a second one.
 */
async function settle(chain: ServiceChain, job: BountyJob, verdict: BountyVerdict): Promise<Hex> {
  const board = chain.deployment.bountyBoard;
  const id = BigInt(job.submissionId);
  const now = await chain.read.readContract({
    address: board,
    abi: bountyBoardAbi,
    functionName: "getSubmission",
    args: [id],
  });
  if (now.status === ACCEPTED || now.status === REJECTED) {
    const range = {
      address: board,
      args: { id },
      fromBlock: BigInt(chain.deployment.deployedAtBlock),
      toBlock: "latest",
      strict: true,
    } as const;
    const logs =
      now.status === ACCEPTED
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
  if (now.status !== REVEALED) throw new Error(`submission ${id} isn't revealed on chain`);
  return verdict.decision === "accept"
    ? chain.send(board, bountyBoardAbi, "accept", [id, BigInt(verdict.reward)])
    : chain.send(board, bountyBoardAbi, "reject", [id, reasonHash(verdict.reason)]);
}
