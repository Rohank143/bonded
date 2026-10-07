import { describeMandate, type EvmMandate } from "@bonded/shared";
import {
  type ApproveParams,
  type CallParams,
  describeAction,
  type SwapParams,
  type TransferParams,
  type VaultAction,
} from "./actions.js";
import type { DryRunResult } from "./breaches.js";
import {
  BondedError,
  PredictedBreachError,
  SentinelError,
  SentinelRefusedError,
  type SentinelVerdict,
} from "./errors.js";
import { checkWithSentinel, type MessageSigner, type SentinelInput } from "./sentinel.js";
import type { ActionResult, BondedVault } from "./vault.js";

/** A token the agent trades, so Sentinel sees symbols and whole units as it was trained on. */
export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export interface SentinelGuardOptions {
  /** The Bonded API that serves `POST /sentinel/check`. */
  apiUrl: string;
  /** The mandate in plain words, or the mandate itself (described with `describeMandate`). */
  mandate: string | EvmMandate;
  /** Names token addresses in the check. */
  tokens?: readonly TokenInfo[];
  /** Defaults to the vault's `agentId()`. */
  agentId?: bigint | number | string;
  /** Defaults to the public client's chain. */
  chainId?: number;
  /** Signs the check. Defaults to the vault's wallet (the agent key). */
  account?: MessageSigner;
  /**
   * When Sentinel can't answer (down, busy, rate limited): "refuse" the action (the default),
   * or "proceed" without its advice. The vault enforces the mandate either way.
   */
  onUnavailable?: "refuse" | "proceed";
  fetch?: typeof fetch;
  /** Give up on Sentinel after this long, in milliseconds. Default 15,000. */
  timeoutMs?: number;
}

export interface GuardOptions {
  /** Ask Sentinel before each write that passes the dry run. Off unless set. */
  sentinel?: SentinelGuardOptions;
}

/** What the agent read before this action, for Sentinel. */
export interface GuardContext {
  untrustedInputs?: readonly SentinelInput[];
}

/** What a guarded write did, and the checks it passed. */
export interface GuardedResult extends ActionResult {
  dryRun: DryRunResult;
  /** Sentinel's answer, when it was asked and answered. */
  sentinel?: SentinelVerdict;
}

/** The checks an action passed, without sending it. */
export interface GuardCheck {
  dryRun: DryRunResult;
  sentinel?: SentinelVerdict;
}

/**
 * A vault that checks every write before sending it: first a dry run of `execute` against the
 * chain's current state, refused if the vault would record a breach (`PredictedBreachError`);
 * then, if configured, Sentinel, refused if it advises against (`SentinelRefusedError`).
 *
 * This turns a Monitor-mode vault into one that doesn't knowingly breach. It is a client-side
 * check: the state can change between the dry run and the transaction, and the vault's own
 * verdict on chain is what counts.
 */
export class GuardedVault {
  /** The chain id and agent id Sentinel checks are signed for, read once. */
  private identity: Promise<[number, bigint | number | string]> | undefined;

  constructor(
    readonly vault: BondedVault,
    private readonly options: GuardOptions = {},
  ) {}

  swap(params: SwapParams, context?: GuardContext): Promise<GuardedResult> {
    return this.execute({ type: "swap", ...params }, context);
  }

  transfer(params: TransferParams, context?: GuardContext): Promise<GuardedResult> {
    return this.execute({ type: "transfer", ...params }, context);
  }

  approve(params: ApproveParams, context?: GuardContext): Promise<GuardedResult> {
    return this.execute({ type: "approve", ...params }, context);
  }

  call(params: CallParams, context?: GuardContext): Promise<GuardedResult> {
    return this.execute({ type: "call", ...params }, context);
  }

  async execute(action: VaultAction, context: GuardContext = {}): Promise<GuardedResult> {
    const checks = await this.check(action, context);
    const result = await this.vault.execute(action);
    return { ...result, ...checks };
  }

  /** Runs the guard's checks on an action and throws if one refuses. Sends nothing. */
  async check(action: VaultAction, context: GuardContext = {}): Promise<GuardCheck> {
    const dryRun = await this.vault.dryRun(action);
    if (!dryRun.ok) throw new PredictedBreachError(dryRun);
    const sentinel = await this.askSentinel(action, context);
    if (sentinel?.blocked) throw new SentinelRefusedError(sentinel);
    return sentinel ? { dryRun, sentinel } : { dryRun };
  }

  private async askSentinel(
    action: VaultAction,
    context: GuardContext,
  ): Promise<SentinelVerdict | undefined> {
    const s = this.options.sentinel;
    if (!s) return undefined;
    const wallet = this.vault.walletClient;
    const account =
      s.account ??
      (wallet
        ? { signMessage: (args) => wallet.signMessage({ account: wallet.account, ...args }) }
        : undefined);
    if (!account)
      throw new BondedError("CONFIG", "Sentinel checks are signed by the agent key; none is set");
    this.identity ??= Promise.all([
      s.chainId ?? this.vault.publicClient.getChainId(),
      s.agentId ?? this.vault.status().then((status) => status.agentId),
    ]);
    const [chainId, agentId] = await this.identity.catch((error: unknown) => {
      this.identity = undefined;
      throw error;
    });
    try {
      return await checkWithSentinel({
        apiUrl: s.apiUrl,
        chainId,
        agentId,
        vault: this.vault.address,
        mandate: typeof s.mandate === "string" ? s.mandate : describeMandate(s.mandate, s.tokens),
        proposedAction: describeAction(action, s.tokens),
        untrustedInputs: context.untrustedInputs ?? [],
        account,
        signal: AbortSignal.timeout(s.timeoutMs ?? 15_000),
        ...(s.fetch ? { fetch: s.fetch } : {}),
      });
    } catch (error) {
      // Only unavailability may be skipped; a refused request (bad signature, wrong vault) is a bug.
      const unavailable =
        error instanceof SentinelError &&
        (error.status === undefined || error.status === 429 || error.status >= 500);
      if (unavailable && s.onUnavailable === "proceed") return undefined;
      throw error;
    }
  }
}

/** Wraps a vault so every write is dry-run (and optionally checked by Sentinel) first. */
export function guarded(vault: BondedVault, options: GuardOptions = {}): GuardedVault {
  return new GuardedVault(vault, options);
}
