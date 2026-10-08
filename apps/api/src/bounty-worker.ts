import { remotePolicyFromEnv, remoteQuota, type RemoteRatingPolicy } from "./remote-policy.js";
import type { Database } from "@bonded/db";
import {
  Sandbox,
  loadAttackLibrary,
  reasonHash,
  validateBounty,
  decideBounty,
  duplicateOf,
  coveredSurface,
  type BountyVerdict,
} from "@bonded/arena";
import { AttackSpec, bondedRegistryAbi, bountyBoardAbi } from "@bonded/shared";
import type { ServiceChain } from "@bonded/keeper";
import { getAbiItem, type Hex } from "viem";

/**
 * Validates revealed bounties (docs/SPECIFICATION.md Section 13.1): runs the spec against the reference
 * agents, then the attester accepts (paying the reward from BountyBoard) or rejects on chain. An
 * accepted spec joins the library and every enabled agent on the chain is queued for a fresh
 * rating in the same database transaction, so premiums reprice against the new attack. The
 * measurements are stored before sending and reused on retry; unpaid approvals recheck
 * duplicate eligibility, and a submission already
 * settled on chain is recorded as the chain has it.
 */

/** The library a chain rates against: the repo's seeds plus accepted bounties. */
export async function chainLibrary(db: Database, chainId: number): Promise<AttackSpec[]> {
  const accepted = (await db.acceptedAttacks(chainId)).map((s) => AttackSpec.parse(s));
  return [...loadAttackLibrary(), ...accepted];
}

/**
 * Attesters judge bounties, so they can't claim one. BountyBoard doesn't check this on chain
 * (docs/AUDIT.md), so the worker rejects such a submission without running the attack.
 */
export const ATTESTER_HUNTER_VERDICT: BountyVerdict = {
  decision: "reject",
  reward: "0",
  reason: "the hunter is an attester; attesters judge bounties and can't claim them",
  breaches: { undefended: 0, defended: 0 },
  runs: 0,
  newSurface: false,
};

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
  /**
   * The policy for operator-run agents' re-ratings on acceptance (their caps), the same one the
   * rest of the service uses (default: as configured in the environment).
   */
  options: { remotePolicy?: RemoteRatingPolicy } = {},
): Promise<boolean> {
  const chainId = chain.deployment.chainId;
  const remotePolicy = options.remotePolicy ?? remotePolicyFromEnv();
  const lock = await db.pool.connect();
  const locked = (await lock.query("SELECT pg_try_advisory_lock(7004,$1) AS locked", [chainId]))
    .rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    return await workLocked(db, chain, rpcUrl, remotePolicy, onError);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(7004,$1)", [chainId]);
    lock.release();
  }
}

async function workLocked(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  remotePolicy: RemoteRatingPolicy,
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
      await db.finishBounty(
        job,
        {
          status: accepted ? "accepted" : "rejected",
          verdict,
          txHash: await settledTransaction(chain, id, accepted),
        },
        remoteQuota(remotePolicy, Date.now()),
      );
      return true;
    }
    if (onChain.status !== REVEALED) throw new Error(`submission ${id} isn't revealed on chain`);
    // Never fail or resend while a previous broadcast could still mine. A known reverted
    // receipt is safe to retry; missing hashes/receipts remain reconcilable even after the cap.
    // A send whose hash never got recorded (the worker stopped mid-broadcast) is resolved by its
    // nonce: used while still unsettled means it never landed; unused means re-send it with
    // that same nonce, so the original and the re-send can't both mine.
    let resendNonce: number | undefined;
    if (job.broadcastPending && !job.pendingTxHash) {
      if (job.pendingNonce === null)
        throw new Error("broadcast outcome unknown and no nonce recorded; awaiting the chain");
      const used = await chain.read.getTransactionCount({
        address: chain.wallet.account.address,
        blockTag: "latest",
      });
      if (used > job.pendingNonce) {
        await check();
        await db.recordBountyBroadcast(job, false);
        throw new Error("the pending nonce was used without settling; sending again next attempt");
      }
      resendNonce = job.pendingNonce;
    } else if (job.broadcastPending) {
      const receipt = await chain.read.getTransactionReceipt({ hash: job.pendingTxHash as Hex });
      if (receipt.status === "success")
        throw new Error("broadcast mined; awaiting updated submission state");
      await check();
      await db.recordBountyBroadcast(job, false);
      throw new Error("prior broadcast reverted; scheduling the next sending attempt");
    }
    // Exhaustion limits validation and sending, never reconciliation of a mined payout.
    if (resendNonce === undefined && job.attempts > 3) {
      await check();
      await db.finishBounty(job, {
        failed: "validation failed after three attempts; chain still revealed",
      });
      return true;
    }
    // Measure once. Reuse recorded breaches and check current payout eligibility below.
    const spec = AttackSpec.parse(job.spec);
    // A pending accept reserves its attack until the chain resolves it, preventing two
    // nonce-ordered payouts for the same payload. Ratings still use accepted attacks only.
    const library = [
      ...loadAttackLibrary(),
      ...(await db.bountyValidationAttacks(chainId, job.submissionId)).map((s) =>
        AttackSpec.parse(s),
      ),
    ];
    let verdict = job.verdict as BountyVerdict | null;
    if (resendNonce !== undefined && !verdict)
      throw new Error("a pending send has no recorded verdict; awaiting the chain");
    // Checked on every fresh attempt, so an attester added after the reveal is caught too. A
    // re-send keeps its recorded verdict: it must be the exact call its nonce may already carry.
    const hunterIsAttester =
      resendNonce === undefined &&
      (await chain.read.readContract({
        address: chain.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "isAttester",
        args: [onChain.hunter],
      }));
    if (hunterIsAttester) {
      verdict = ATTESTER_HUNTER_VERDICT;
      await check();
      await db.recordBountyVerdict(job, verdict);
    } else if (!verdict) {
      const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
      try {
        verdict = await validateBounty(sandbox, spec, library, { onRun: check });
      } finally {
        await sandbox.stop();
      }
      await check();
      await db.recordBountyVerdict(job, verdict);
    }
    // The measured breaches are stable; eligibility isn't reserved by an unpaid approval.
    // Another accepted bounty may now cover it. Recheck only while the chain is Revealed, and
    // never for a re-send: it must be the exact call the pending nonce may already carry.
    if (resendNonce === undefined && !hunterIsAttester) {
      verdict = decideBounty({
        duplicateOf: duplicateOf(spec, library),
        breaches: verdict.breaches,
        newSurface: !coveredSurface(spec, library),
        runs: verdict.runs,
      });
      await check();
      await db.recordBountyVerdict(job, verdict);
    }
    const lifecycle = {
      ...(resendNonce === undefined ? {} : { nonce: resendNonce }),
      beforeBroadcast: async (nonce: number) => {
        await check();
        await db.recordBountyBroadcast(job, true, null, nonce);
      },
      onBroadcast: (hash: Hex) => db.recordBountyBroadcast(job, true, hash),
      onReverted: () => db.recordBountyBroadcast(job, false),
    };
    await check();
    const txHash =
      verdict.decision === "accept"
        ? await chain.send(board, bountyBoardAbi, "accept", [id, BigInt(verdict.reward)], lifecycle)
        : await chain.send(
            board,
            bountyBoardAbi,
            "reject",
            [id, reasonHash(verdict.reason)],
            lifecycle,
          );
    // Operator-run agents' re-ratings count against their caps like any other rating.
    await db.finishBounty(
      job,
      { status: verdict.decision === "accept" ? "accepted" : "rejected", verdict, txHash },
      remoteQuota(remotePolicy, Date.now()),
    );
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
