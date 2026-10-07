import { type BreachType, breachTypeFromCode, mandateVaultAbi } from "@bonded/shared";
import { type Address, type Hex, isAddressEqual, type Log, parseEventLogs } from "viem";

/** One entry in the vault's breach log: what pays claims and decides ratings. */
export interface VaultBreach {
  /** Index in the vault's log (`getBreach(id)`); predicted ids in a dry run. */
  id: bigint;
  type: BreachType;
  /** Plain-language reason, from the breach type. */
  reason: string;
  /** The contract the action called; the zero address for a breach found by `reconcile`. */
  target: Address;
  /** The function called (4-byte selector). */
  selector: Hex;
  /** Value lost, in USD with 6 decimals (0 when blocked). */
  lossUsd6: bigint;
  /** Enforce mode stopped the action: nothing moved. */
  blocked: boolean;
}

const REASONS: Record<BreachType, string> = {
  T1_UNAUTHORIZED_TARGET: "the mandate doesn't allow calling this contract or function",
  T1_UNAUTHORIZED_APPROVAL: "the mandate doesn't allow approving this spender",
  T1_UNAUTHORIZED_TRANSFER:
    "the recipient is neither the vault nor one of the mandate's destinations",
  T1_DEFERRED: "the vault's balances dropped earlier without an action that explains it",
  T2_LIMIT: "the action goes over the mandate's per-trade or daily limit",
  T3_ASSET:
    "the action loses more value than the mandate's slippage allows (e.g. a honeypot or lookalike token)",
};

/** Why the vault records a breach of this type, in plain words. */
export function breachReason(type: BreachType): string {
  return REASONS[type];
}

/** What the vault's events say about one `execute`: whether the call ran, and what it recorded. */
export interface ExecuteOutcome {
  /** The call ran (an `Executed` event). False when Enforce mode blocked it or a freeze skipped it. */
  executed: boolean;
  breaches: VaultBreach[];
  /** The vault froze during this action. */
  froze: boolean;
}

/** Reads the outcome of `execute` from its logs; only logs emitted by `vault` count. */
export function readExecuteOutcome(vault: Address, logs: readonly Log[]): ExecuteOutcome {
  const own = logs.filter((log) => isAddressEqual(log.address, vault));
  const events = parseEventLogs({
    abi: mandateVaultAbi,
    logs: own as Log[],
    eventName: ["Executed", "BreachRecorded", "Frozen"],
  });
  const breaches: VaultBreach[] = [];
  let executed = false;
  let froze = false;
  for (const event of events) {
    if (event.eventName === "Executed") executed = true;
    else if (event.eventName === "Frozen") froze = true;
    else {
      const type = breachTypeFromCode(event.args.breachType);
      breaches.push({
        id: event.args.breachId,
        type,
        reason: breachReason(type),
        target: event.args.target,
        selector: event.args.selector,
        lossUsd6: event.args.lossUsd6,
        blocked: event.args.blocked,
      });
    }
  }
  return { executed, breaches, froze };
}

/**
 * What the vault would do with an action, from simulating `execute` against the chain's
 * current state: the contract's own checks, not a copy of them.
 */
export interface DryRunResult {
  /** The action would run and the vault would record no breach. */
  ok: boolean;
  /** The call would run. False when Enforce mode would block it or a freeze would skip it. */
  executed: boolean;
  /** Enforce mode would stop it (the attempt is still recorded as a breach). */
  blocked: boolean;
  /** The breach this action would cause, if any (an earlier unexplained outflow comes first). */
  breach?: VaultBreach;
  /** Every breach the vault would record, in order. */
  breaches: VaultBreach[];
  /** The vault would freeze. */
  wouldFreeze: boolean;
}

export function toDryRunResult(outcome: ExecuteOutcome): DryRunResult {
  const own = outcome.breaches.find((b) => b.type !== "T1_DEFERRED") ?? outcome.breaches[0];
  return {
    ok: outcome.executed && outcome.breaches.length === 0,
    executed: outcome.executed,
    blocked: outcome.breaches.some((b) => b.blocked),
    ...(own ? { breach: own } : {}),
    breaches: outcome.breaches,
    wouldFreeze: outcome.froze,
  };
}
