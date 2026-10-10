import type { Database } from "@bonded/db";
import { SCORE_EXPIRY_WARNING_SECONDS, breachTypeFromCode } from "@bondedhq/shared";
import type { AgentStatusReader } from "./agent-status.js";
import { ratingDue, runnerOffline } from "./agent-health.js";
import { agentNotification, type Notifier } from "./notifications.js";

/**
 * The owner's alerts about their agents, beyond rating outcomes (bring your own agent, launch
 * round): score expiring in 7 days, the runner offline over 30 minutes while a rating or renewal
 * is due, a breach recorded on the vault, a claim filed or paid, cover lapsing, low gas. One
 * sweep a minute on the keeper; each event has a dedupe key, so it is sent once, and owners can
 * turn each type off. Only agents their owners registered (self-serve) are swept.
 */

/** Breaches and claims older than this aren't announced (say, on the first sweep after a deploy). */
const RECENT_MS = 7 * 86_400_000;

const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

interface SweptAgent {
  key: string;
  agentId: string;
  owner: string;
  config: { kind?: string; vault?: string; connection?: string; mode?: string };
}

export class OwnerAlerts {
  constructor(
    private readonly db: Database,
    private readonly chainId: number,
    private readonly notifier: Notifier,
    private readonly status: AgentStatusReader,
    private readonly now: () => number = Date.now,
  ) {}

  /** One sweep. Returns how many notifications were new. */
  async sweep(): Promise<number> {
    const agents = (
      await this.db.pool.query(
        `SELECT id, agent_id::text AS agent_id, owner, config FROM agents
         WHERE chain_id=$1 AND enabled AND source='user' AND owner IS NOT NULL`,
        [this.chainId],
      )
    ).rows.map((r): SweptAgent => ({
      key: r.id,
      agentId: r.agent_id,
      owner: r.owner,
      config: r.config,
    }));
    let sent = 0;
    for (const agent of agents) {
      try {
        sent += await this.agentAlerts(agent);
      } catch {
        // One agent's chain read failing doesn't stop the others.
      }
    }
    sent += await this.vaultEvents(agents);
    return sent;
  }

  private async send(
    agent: SweptAgent,
    type: Parameters<typeof agentNotification>[0]["type"],
    dedupeKey: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
    code?: string,
  ) {
    const ok = await this.notifier.deliver(
      agent.owner,
      agentNotification({
        type,
        dedupeKey,
        agentId: agent.agentId,
        chainId: this.chainId,
        message,
        ...(code ? { code } : {}),
        ...(details ? { details } : {}),
        at: new Date(this.now()).toISOString(),
      }),
    );
    return ok ? 1 : 0;
  }

  private async agentAlerts(agent: SweptAgent): Promise<number> {
    const nowMs = this.now();
    let sent = 0;
    const score = (
      await this.db.pool.query(
        `SELECT id, (signed->'attestation'->>'expiresAt')::bigint AS expires FROM attestations
         WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [agent.key],
      )
    ).rows[0] as { id: string; expires: string } | undefined;
    const expiresS = score ? Number(score.expires) : undefined;
    if (
      score &&
      expiresS! > nowMs / 1000 &&
      expiresS! - nowMs / 1000 <= SCORE_EXPIRY_WARNING_SECONDS
    )
      sent += await this.send(
        agent,
        "score_expiring",
        `score_expiring:${score.id}`,
        `The agent's score expires on ${date(expiresS! * 1000)}.`,
        { expiresAt: new Date(expiresS! * 1000).toISOString() },
      );

    // Runner offline while a rating or renewal is due (agents reached by their runner).
    if (agent.config.kind === "remote") {
      const connection = await this.db.connectionOf(agent.key, agent.config);
      if (connection === "runner") {
        const [status, pending] = await Promise.all([
          this.db.runnerStatus(agent.key),
          this.db.pool.query(
            `SELECT 1 FROM ratings r JOIN jobs j ON j.id=r.id
             WHERE r.agent_id=$1 AND j.status IN ('queued','running') LIMIT 1`,
            [agent.key],
          ),
        ]);
        const runner = status.runner
          ? { connected: status.runner.connected, lastHeartbeatAt: status.runner.lastHeartbeatAt }
          : null;
        const due = ratingDue({
          nowMs,
          score: expiresS !== undefined ? { expiresAtSeconds: expiresS } : null,
          pending: pending.rowCount ? { status: "queued" } : null,
        });
        if (status.token && due && runnerOffline({ nowMs, runner }))
          sent += await this.send(
            agent,
            "runner_offline",
            // One per offline stretch: a new heartbeat starts a new one.
            `runner_offline:${agent.key}:${runner?.lastHeartbeatAt.toISOString() ?? "never"}`,
            runner
              ? `The runner has been offline since ${date(runner.lastHeartbeatAt.getTime())} while a rating or renewal is due.`
              : "The runner has been offline (it never connected) while a rating or renewal is due.",
          );
      }
    }

    // The vault: cover lapsing, low gas.
    if (agent.config.vault) {
      const chain = await this.status.read(agent.config.vault);
      const cover = chain.cover;
      if (cover?.status === "lapsed")
        sent += await this.send(
          agent,
          "cover_lapsing",
          `cover_lapsed:${cover.policyId}`,
          "The cover lapsed: its premium went unpaid past the grace period.",
          { policyId: cover.policyId },
          "cover-lapsing",
        );
      else if (cover?.active && cover.pastDueSince)
        sent += await this.send(
          agent,
          "cover_lapsing",
          `cover_past_due:${cover.policyId}:${cover.pastDueSince}`,
          `The cover's premium is past due; the cover lapses${cover.lapsesAt ? ` at ${date(Date.parse(cover.lapsesAt))}` : ""} unless it is paid.`,
          { policyId: cover.policyId, lapsesAt: cover.lapsesAt },
        );
      const lastTrade = chain.vaultActivity.lastTradeAt
        ? Date.parse(chain.vaultActivity.lastTradeAt)
        : undefined;
      const inUse =
        cover?.active === true || (lastTrade !== undefined && nowMs - lastTrade < RECENT_MS);
      if (chain.agentGas?.low && inUse)
        sent += await this.send(
          agent,
          "low_gas",
          // At most one a day while it stays low.
          `low_gas:${agent.key}:${new Date(nowMs).toISOString().slice(0, 10)}`,
          chain.agentGas.estimatedTradesLeft === null
            ? "The agent key is low on gas."
            : `The agent key is low on gas: about ${chain.agentGas.estimatedTradesLeft} trades left.`,
          {
            agentKey: chain.agentKey,
            balanceEth: chain.agentGas.balanceEth,
            estimatedTradesLeft: chain.agentGas.estimatedTradesLeft,
          },
        );
    }
    return sent;
  }

  /** Breaches the keeper indexed on owners' vaults, and the claims it filed and was paid. */
  private async vaultEvents(agents: SweptAgent[]): Promise<number> {
    const byVault = new Map(
      agents.filter((a) => a.config.vault).map((a) => [a.config.vault!.toLowerCase(), a]),
    );
    if (byVault.size === 0) return 0;
    const since = new Date(this.now() - RECENT_MS);
    const rows = (
      await this.db.pool.query(
        `SELECT id, vault, breach_id::text AS breach_id, breach_type, blocked, status, tx_hash,
           claim_filed_at
         FROM handled_events WHERE chain_id=$1 AND vault=ANY($2::text[])
           AND (occurred_at > $3 OR claim_filed_at > $3)`,
        [this.chainId, [...byVault.keys()], since],
      )
    ).rows;
    let sent = 0;
    for (const e of rows) {
      const agent = byVault.get(e.vault)!;
      const type = e.breach_type === null ? "a breach" : breachTypeFromCode(Number(e.breach_type));
      const details = { breachId: e.breach_id, breachType: type, blocked: e.blocked };
      sent += await this.send(
        agent,
        "breach_recorded",
        `breach:${e.id}`,
        e.blocked
          ? `The vault recorded a breach (${type}) and blocked it, so nothing was lost.`
          : `The vault recorded a breach (${type}).`,
        details,
      );
      if (e.claim_filed_at)
        sent += await this.send(
          agent,
          "claim_filed",
          `claim_filed:${e.id}`,
          `A claim was filed for breach ${e.breach_id}.`,
          details,
        );
      if (e.status === "claimed" && e.tx_hash)
        sent += await this.send(
          agent,
          "claim_paid",
          `claim_paid:${e.id}`,
          `The claim for breach ${e.breach_id} was paid.`,
          { ...details, txHash: e.tx_hash },
        );
    }
    return sent;
  }
}
