import { Database } from "@bonded/db";
import {
  claimsEngineAbi,
  BREACH_TYPE_CODE,
  coverManagerAbi,
  mandateModuleFactoryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
} from "@bonded/shared";
import { getAbiItem, type Address } from "viem";
import type { ServiceChain } from "./chain.js";
export * from "./chain.js";
export * from "./solana.js";

/** One durable scanner and transaction sender per chain. Finalized cursor mismatch fails closed. */
export class Keeper {
  private lastAccrual = 0;
  constructor(
    readonly db: Database,
    readonly chain: ServiceChain,
    readonly confirmations = 5n,
    /**
     * How often to accrue every active policy's premium. Each accrual is a transaction, so this
     * sets most of the keeper's gas use. Claims, cancellations and new cover accrue on chain when
     * they happen, so this only keeps the pool's income and lapses current between those.
     */
    readonly accrueIntervalMs = 60 * 60_000,
  ) {}
  /** Index a confirmed batch, accrue policies independently, then retry saved breaches. */
  async tick() {
    const c = await this.db.pool.connect();
    const id = this.chain.deployment.chainId;
    let locked = false;
    try {
      locked = (await c.query("SELECT pg_try_advisory_lock(7003,$1) AS locked", [id])).rows[0]
        .locked;
      if (!locked) return;
      await this.scan();
      if (Date.now() - this.lastAccrual >= this.accrueIntervalMs) {
        const policies = await this.db.pool.query(
          "SELECT policy_id FROM keeper_policies WHERE chain_id=$1",
          [id],
        );
        for (const p of policies.rows) {
          try {
            const policy = await this.chain.read.readContract({
              address: this.chain.deployment.coverManager,
              abi: coverManagerAbi,
              functionName: "getPolicy",
              args: [BigInt(p.policy_id)],
            });
            if (policy.status === 1)
              await this.chain.send(this.chain.deployment.coverManager, coverManagerAbi, "accrue", [
                BigInt(p.policy_id),
              ]);
          } catch {
            await this.db.publish("keeper.accrual_failed", { chainId: id, policyId: p.policy_id });
          }
        }
        this.lastAccrual = Date.now();
      }
      await this.claim();
    } finally {
      if (locked) await c.query("SELECT pg_advisory_unlock(7003,$1)", [id]);
      c.release();
    }
  }
  /** Commit discovered vaults, policies and breaches with their confirmed block cursor. */
  private async scan() {
    const { read, deployment: d } = this.chain;
    if ((await read.getChainId()) !== d.chainId) throw new Error("RPC chain mismatch");
    const cursor = (
      await this.db.pool.query("SELECT * FROM keeper_cursors WHERE chain_id=$1", [d.chainId])
    ).rows[0];
    if (cursor) {
      const previous = await read.getBlock({ blockNumber: BigInt(cursor.block_number) });
      if (previous.hash !== cursor.block_hash)
        throw new Error("keeper cursor reorg: operator reconciliation required");
    }
    const from = cursor ? BigInt(cursor.block_number) + 1n : BigInt(d.deployedAtBlock);
    const head = await read.getBlockNumber({ cacheTime: 0 });
    if (head < this.confirmations || from > head - this.confirmations) return;
    const to = head - this.confirmations < from + 499n ? head - this.confirmations : from + 499n;
    const created = await read.getLogs({
      address: d.factory,
      event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    const bound = await read.getLogs({
      address: d.coverManager,
      event: getAbiItem({ abi: coverManagerAbi, name: "CoverBound" }),
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    // MandateModules on smart accounts record breaches with the same event, and can hold cover.
    const modules = d.moduleFactory
      ? await read.getLogs({
          address: d.moduleFactory,
          event: getAbiItem({ abi: mandateModuleFactoryAbi, name: "ModuleCreated" }),
          fromBlock: from,
          toBlock: to,
          strict: true,
        })
      : [];
    const known = await this.db.pool.query("SELECT address FROM keeper_vaults WHERE chain_id=$1", [
      d.chainId,
    ]);
    const vaults = [
      ...new Set([
        ...known.rows.map((v): Address => v.address),
        ...created.map((v) => v.args.vault.toLowerCase() as Address),
        ...modules.map((m) => m.args.module.toLowerCase() as Address),
      ]),
    ];
    const breaches = (
      await Promise.all(
        vaults.map((address) =>
          read.getLogs({
            address,
            event: getAbiItem({ abi: mandateVaultAbi, name: "BreachRecorded" }),
            fromBlock: from,
            toBlock: to,
            strict: true,
          }),
        ),
      )
    ).flat();
    const block = await read.getBlock({ blockNumber: to });
    // What each breach was and when, for observed breach rates (GET /stats/observed-rates). Read
    // before the transaction; breaches are rare, so a few reads per batch at most.
    const agentOf = new Map<string, Promise<bigint>>();
    const timeOf = new Map<bigint, Promise<bigint>>();
    const details = await Promise.all(
      breaches.map(async (b) => {
        const vault = b.address.toLowerCase();
        if (!agentOf.has(vault))
          agentOf.set(
            vault,
            read.readContract({
              address: b.address,
              abi: mandateVaultAbi,
              functionName: "agentId",
            }),
          );
        if (!timeOf.has(b.blockNumber))
          timeOf.set(
            b.blockNumber,
            read.getBlock({ blockNumber: b.blockNumber }).then((x) => x.timestamp),
          );
        return {
          agentId: (await agentOf.get(vault)!).toString(),
          at: new Date(Number(await timeOf.get(b.blockNumber)!) * 1000),
        };
      }),
    );
    await this.db.transaction(async (c) => {
      for (const address of vaults)
        await c.query("INSERT INTO keeper_vaults VALUES($1,$2) ON CONFLICT DO NOTHING", [
          d.chainId,
          address,
        ]);
      for (const p of bound)
        await c.query("INSERT INTO keeper_policies VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [
          d.chainId,
          p.args.policyId.toString(),
          p.args.vault.toLowerCase(),
        ]);
      for (const [i, b] of breaches.entries())
        await c.query(
          `INSERT INTO handled_events(id,chain_id,vault,breach_id,agent_id,breach_type,blocked,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            `${d.chainId}:${b.transactionHash}:${b.logIndex}`,
            d.chainId,
            b.address.toLowerCase(),
            b.args.breachId.toString(),
            details[i]!.agentId,
            b.args.breachType,
            b.args.blocked,
            details[i]!.at,
          ],
        );
      await c.query(
        "INSERT INTO keeper_cursors VALUES($1,$2,$3) ON CONFLICT(chain_id) DO UPDATE SET block_number=$2,block_hash=$3",
        [d.chainId, to.toString(), block.hash],
      );
    });
  }
  /** Pay eligible breaches; only classify a no-match after indexing through its block. */
  private async claim() {
    const { read, deployment: d } = this.chain;
    const pending = await this.db.pool.query(
      "SELECT * FROM handled_events WHERE chain_id=$1 AND status='pending' ORDER BY id",
      [d.chainId],
    );
    for (const e of pending.rows) {
      try {
        const breach = await read.readContract({
          address: e.vault as Address,
          abi: mandateVaultAbi,
          functionName: "getBreach",
          args: [BigInt(e.breach_id)],
        });
        // A module can't tell an unexplained drop (Deferred) from its account's owner moving
        // funds, so ClaimsEngine doesn't pay those on modules (BreachNotCovered).
        if (
          breach.breachType === BREACH_TYPE_CODE.T1_DEFERRED &&
          !(await read.readContract({
            address: d.factory,
            abi: mandateVaultFactoryAbi,
            functionName: "isVault",
            args: [e.vault as Address],
          }))
        ) {
          await this.db.pool.query(
            "UPDATE handled_events SET status='ignored',error=$2 WHERE id=$1",
            [e.id, "a deferred breach on a smart-account module isn't covered"],
          );
          continue;
        }
        if (breach.claimed || breach.blocked || breach.lossUsd6 === 0n) {
          await this.db.pool.query("UPDATE handled_events SET status=$2,error=NULL WHERE id=$1", [
            e.id,
            breach.claimed ? "claimed" : "ignored",
          ]);
          continue;
        }
        // Keep historical policies: activePolicyOf is cleared when a policy closes.
        const policies = await this.db.pool.query(
          "SELECT policy_id FROM keeper_policies WHERE chain_id=$1 AND vault=$2 ORDER BY policy_id",
          [d.chainId, e.vault],
        );
        let claimed = false;
        for (const p of policies.rows) {
          const policyId = BigInt(p.policy_id);
          const [start, end] = await read.readContract({
            address: d.coverManager,
            abi: coverManagerAbi,
            functionName: "coverageWindow",
            args: [policyId],
          });
          const window = await read.readContract({
            address: d.claimsEngine,
            abi: claimsEngineAbi,
            functionName: "claimWindow",
          });
          const now = (await read.getBlock()).timestamp;
          if (breach.timestamp < start || breach.timestamp > end || now > end + window) continue;
          // Simulation repeats the checks after accrual, including lapse, deductible and liquidity.
          const hash = await this.chain.send(d.claimsEngine, claimsEngineAbi, "fileClaim", [
            policyId,
            [BigInt(e.breach_id)],
          ]);
          await this.db.transaction(async (c) => {
            await c.query(
              "UPDATE handled_events SET status='claimed',tx_hash=$2,error=NULL WHERE id=$1",
              [e.id, hash],
            );
            await this.db.publish(
              "claim.paid",
              { chainId: d.chainId, vault: e.vault, breachId: e.breach_id, hash },
              c,
            );
          });
          claimed = true;
          break;
        }
        if (!claimed) {
          // Both policy and breach logs are committed through the same cursor. A later
          // policy cannot cover an earlier block, but may cover an earlier transaction at
          // the SAME timestamp (coverageWindow is inclusive). Wait until the scanner has
          // reached a strictly later timestamp before making this classification terminal.
          const cursor = (
            await this.db.pool.query("SELECT block_number FROM keeper_cursors WHERE chain_id=$1", [
              d.chainId,
            ])
          ).rows[0];
          const scanned = cursor
            ? await read.getBlock({ blockNumber: BigInt(cursor.block_number) })
            : undefined;
          const complete = !!scanned && scanned.timestamp > breach.timestamp;
          await this.db.pool.query("UPDATE handled_events SET status=$2,error=$3 WHERE id=$1", [
            e.id,
            complete ? "ignored" : "pending",
            complete
              ? "no policy covers this breach within its claim window"
              : "waiting for policy indexing past breach timestamp",
          ]);
        }
      } catch {
        await this.db.pool.query("UPDATE handled_events SET error=$2 WHERE id=$1", [
          e.id,
          "claim failed; will retry",
        ]);
      }
    }
  }
}
