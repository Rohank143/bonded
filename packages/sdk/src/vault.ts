import { breachTypeFromCode, mandateVaultAbi } from "@bonded/shared";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddressEqual,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { simulateCalls } from "viem/actions";
import {
  type ApproveParams,
  type CallParams,
  demoRouter,
  erc20Call,
  normaliseAction,
  type SwapParams,
  type SwapRouter,
  type TransferParams,
  type VaultAction,
  type VaultCall,
} from "./actions.js";
import {
  breachReason,
  type DryRunResult,
  type ExecuteOutcome,
  readExecuteOutcome,
  toDryRunResult,
  type VaultBreach,
} from "./breaches.js";
import {
  BlockedByMandateError,
  BondedError,
  CallRevertedError,
  NotAgentError,
  VaultFrozenError,
} from "./errors.js";

export interface BondedVaultConfig {
  /** The Mandate Vault's address. */
  vault: Address;
  /** Reads the chain. Built from `chain` (and `rpcUrl`) when left out. */
  publicClient?: PublicClient<Transport, Chain | undefined>;
  /** Sends as the vault's agent key. Built from `account` (and `chain`, `rpcUrl`) when left out. */
  walletClient?: WalletClient<Transport, Chain | undefined, Account>;
  /** The vault's agent key. Without it (or a wallet client) the vault is read-only. */
  account?: Account;
  chain?: Chain;
  /** RPC URL. Defaults to the public client's, or the chain's own. */
  rpcUrl?: string;
  /**
   * Where `swap` trades: an allowed target of the mandate. An address means Bonded's testnet
   * market (`DemoRouter`); pass a `SwapRouter` for any other venue.
   */
  router?: Address | SwapRouter;
}

/** What the vault is and whether it will act. */
export interface VaultStatus {
  /** The agent can't act until the guardian unfreezes the vault. */
  frozen: boolean;
  /** Monitor lets breaches through and records them; Enforce blocks and records them. */
  mode: "monitor" | "enforce";
  breachCount: bigint;
  /** The key that can call `execute`. */
  agent: Address;
  /** Can freeze, unfreeze and rotate the agent key. */
  guardian: Address;
  mandateHash: Hex;
  agentId: bigint;
  freezeOnBreach: boolean;
}

/** What a write did. Monitor mode lets breaches through: check `breaches`. */
export interface ActionResult {
  /** One transaction per `execute` sent (a swap may need an approval first). */
  hashes: Hex[];
  /** Breaches the vault recorded while running the action. Empty when it kept to the mandate. */
  breaches: VaultBreach[];
}

/**
 * A Mandate Vault, from the agent's side. Every write is `MandateVault.execute(target, data)`
 * sent from the agent key, so the vault checks it against the mandate and records any breach.
 *
 * ```ts
 * const vault = new BondedVault({ vault, chain, account: privateKeyToAccount(agentKey) });
 * const check = await vault.dryRun({ type: "transfer", token, to, amount });
 * if (check.ok) await vault.transfer({ token, to, amount });
 * ```
 */
export class BondedVault {
  readonly address: Address;
  readonly publicClient: PublicClient<Transport, Chain | undefined>;
  readonly walletClient: WalletClient<Transport, Chain | undefined, Account> | undefined;
  private readonly router: SwapRouter | undefined;

  constructor(config: BondedVaultConfig) {
    this.address = getAddress(config.vault);
    // Without an rpcUrl, a wallet built here sends through the given public client's RPC.
    const transport =
      config.rpcUrl || !config.publicClient ? http(config.rpcUrl) : custom(config.publicClient);
    if (config.publicClient) this.publicClient = config.publicClient;
    else if (config.chain)
      this.publicClient = createPublicClient({ chain: config.chain, transport });
    else throw new BondedError("CONFIG", "BondedVault needs a publicClient or a chain");
    if (config.walletClient) {
      if (!config.walletClient.account)
        throw new BondedError("CONFIG", "the walletClient needs an account (the agent key)");
      this.walletClient = config.walletClient;
    } else if (config.account) {
      const chain = config.chain ?? this.publicClient.chain;
      if (!chain) throw new BondedError("CONFIG", "BondedVault needs a chain to send transactions");
      this.walletClient = createWalletClient({ account: config.account, chain, transport });
    }
    this.router = typeof config.router === "string" ? demoRouter(config.router) : config.router;
  }

  /** The address that sends this vault's actions, if it can send. */
  get agentAddress(): Address | undefined {
    return this.walletClient?.account.address;
  }

  async status(): Promise<VaultStatus> {
    const read = <F extends ReadFn>(functionName: F) =>
      this.publicClient.readContract({ address: this.address, abi: mandateVaultAbi, functionName });
    const [frozen, mode, breachCount, agent, guardian, mandateHash, agentId, freezeOnBreach] =
      await Promise.all([
        read("frozen"),
        read("mode"),
        read("breachCount"),
        read("agent"),
        read("guardian"),
        read("mandateHash"),
        read("agentId"),
        read("freezeOnBreach"),
      ]);
    return {
      frozen,
      mode: mode === 1 ? "enforce" : "monitor",
      breachCount,
      agent,
      guardian,
      mandateHash,
      agentId,
      freezeOnBreach,
    };
  }

  /** The vault's breach log, oldest first (from `fromId`, default 0). */
  async breaches(fromId = 0n): Promise<VaultBreach[]> {
    const count = await this.publicClient.readContract({
      address: this.address,
      abi: mandateVaultAbi,
      functionName: "breachCount",
    });
    const ids: bigint[] = [];
    for (let id = fromId; id < count; id++) ids.push(id);
    return Promise.all(
      ids.map(async (id) => {
        const b = await this.publicClient.readContract({
          address: this.address,
          abi: mandateVaultAbi,
          functionName: "getBreach",
          args: [id],
        });
        const type = breachTypeFromCode(b.breachType);
        return {
          id,
          type,
          reason: breachReason(type),
          target: b.target,
          selector: b.selector,
          lossUsd6: b.lossUsd6,
          blocked: b.blocked,
        };
      }),
    );
  }

  swap(params: SwapParams): Promise<ActionResult> {
    return this.execute({ type: "swap", ...params });
  }

  transfer(params: TransferParams): Promise<ActionResult> {
    return this.execute({ type: "transfer", ...params });
  }

  approve(params: ApproveParams): Promise<ActionResult> {
    return this.execute({ type: "approve", ...params });
  }

  call(params: CallParams): Promise<ActionResult> {
    return this.execute({ type: "call", ...params });
  }

  /**
   * Sends an action through the vault and waits for it. Resolves when the vault ran it (in
   * Monitor mode possibly with breaches recorded: see `breaches`). Throws `BlockedByMandateError`
   * when Enforce mode stopped it, `VaultFrozenError` when the vault is or became frozen,
   * `NotAgentError` for the wrong key and `CallRevertedError` when the call itself failed.
   */
  async execute(action: VaultAction): Promise<ActionResult> {
    const wallet = this.requireWallet();
    const calls = await this.plan(action);
    const result: ActionResult = { hashes: [], breaches: [] };
    for (const [i, call] of calls.entries()) {
      let hash: Hex;
      try {
        hash = await wallet.writeContract({
          address: this.address,
          abi: mandateVaultAbi,
          functionName: "execute",
          args: [call.target, call.data],
          account: wallet.account,
          chain: wallet.chain,
        });
      } catch (error) {
        throw this.translate(error, call);
      }
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new BondedError("REVERTED", `execute reverted on chain (transaction ${hash})`);
      const outcome = readExecuteOutcome(this.address, receipt.logs);
      result.hashes.push(hash);
      result.breaches.push(...outcome.breaches);
      if (!outcome.executed) {
        const blocked = outcome.breaches.find((b) => b.blocked);
        if (blocked) throw new BlockedByMandateError(blocked, hash);
        throw new VaultFrozenError(this.address, outcome.breaches[0], hash);
      }
      // A breach froze the vault partway through: the rest of the action can't be sent.
      if (outcome.froze && i < calls.length - 1)
        throw new VaultFrozenError(this.address, outcome.breaches[0], hash);
    }
    return result;
  }

  /**
   * What the vault would do with `action` right now: simulates `execute` from the agent key
   * against the chain's current state (`eth_simulateV1`) and reads the vault's own events, so
   * the verdict is the contract's, never a copy of its rules. Nothing is sent.
   *
   * Throws what sending would throw before the vault judges anything: `VaultFrozenError`,
   * `NotAgentError`, `CallRevertedError`.
   */
  async dryRun(action: VaultAction): Promise<DryRunResult> {
    const calls = await this.plan(action);
    const from =
      this.agentAddress ??
      (await this.publicClient.readContract({
        address: this.address,
        abi: mandateVaultAbi,
        functionName: "agent",
      }));
    let simulation;
    try {
      // The action from this package's viem, so a caller's older client works too.
      simulation = await simulateCalls(this.publicClient, {
        account: from,
        calls: calls.map((call) => ({
          to: this.address,
          abi: mandateVaultAbi,
          functionName: "execute" as const,
          args: [call.target, call.data] as const,
        })),
      });
    } catch (error) {
      if (isUnsupported(error))
        throw new BondedError(
          "DRY_RUN_UNSUPPORTED",
          "this RPC doesn't support eth_simulateV1, which dry runs need; use an RPC that does",
          { cause: error },
        );
      throw error;
    }
    const merged: ExecuteOutcome = { executed: true, breaches: [], froze: false };
    for (const [i, result] of simulation.results.entries()) {
      if (result.status === "failure") {
        // An earlier step's breach froze the vault: the prediction is that breach.
        if (merged.froze) return toDryRunResult({ ...merged, executed: false });
        throw this.translate(result.error, calls[i]!, from);
      }
      const outcome = readExecuteOutcome(this.address, result.logs ?? []);
      merged.breaches.push(...outcome.breaches);
      merged.froze ||= outcome.froze;
      if (!outcome.executed) return toDryRunResult({ ...merged, executed: false });
    }
    return toDryRunResult(merged);
  }

  /** The `execute` calls an action takes, in order. A swap approves the router first if needed. */
  async plan(action: VaultAction): Promise<VaultCall[]> {
    const a = normaliseAction(action);
    switch (a.type) {
      case "transfer":
        return [erc20Call("transfer", a.token, a.to, a.amount)];
      case "approve":
        return [erc20Call("approve", a.token, a.spender, a.amount)];
      case "call":
        if (isAddressEqual(a.target, this.address))
          throw new BondedError("INVALID_ACTION", "the vault can't call itself");
        return [{ target: a.target, data: a.data }];
      case "swap": {
        const router = this.router;
        if (!router)
          throw new BondedError(
            "CONFIG",
            "set `router` to swap (an allowed target of the mandate), or use call()",
          );
        if (a.minOut !== undefined && router.quote) {
          const quoted = await router.quote(this.publicClient as PublicClient, a);
          if (quoted < a.minOut)
            throw new BondedError(
              "BELOW_MIN_OUT",
              `the router quotes ${quoted} for this swap, below minOut ${a.minOut}; nothing was sent`,
            );
        }
        const allowance = await this.publicClient.readContract({
          address: a.tokenIn,
          abi: erc20Abi,
          functionName: "allowance",
          args: [this.address, router.address],
        });
        const swap: VaultCall = {
          target: router.address,
          data: router.encodeSwap({ ...a, minOut: a.minOut ?? 0n, recipient: this.address }),
        };
        return allowance >= a.amountIn
          ? [swap]
          : [erc20Call("approve", a.tokenIn, router.address, a.amountIn), swap];
      }
    }
  }

  private requireWallet() {
    if (!this.walletClient)
      throw new BondedError(
        "READ_ONLY",
        "this BondedVault has no agent key: pass `account` or `walletClient` to send actions",
      );
    return this.walletClient;
  }

  /** Turns a revert of `execute` into the SDK's typed errors. */
  private translate(error: unknown, call: VaultCall, from?: Address): unknown {
    // Matched by name, not instanceof: the caller's clients may come from another copy of viem.
    const reverted = findCause(error, "ContractFunctionRevertedError") as
      | (Error & {
          data?: { errorName?: string };
          reason?: string;
          signature?: Hex;
          raw?: Hex;
        })
      | undefined;
    if (!reverted) return error;
    switch (reverted.data?.errorName) {
      case "NotAgent":
        return new NotAgentError(this.address, from ?? this.agentAddress, { cause: error });
      case "AgentFrozen":
        return new VaultFrozenError(this.address, undefined, undefined, { cause: error });
      case "CannotCallVault":
        return new BondedError("INVALID_ACTION", "the vault can't call itself", { cause: error });
    }
    const why = reverted.reason ?? reverted.data?.errorName ?? reverted.signature;
    return new CallRevertedError(
      `the vault's call to ${call.target} reverted${why ? `: ${why}` : ""}; nothing changed`,
      reverted.raw,
      { cause: error },
    );
  }
}

/** The first error named `name` in `error`'s cause chain. */
function findCause(error: unknown, name: string): Error | undefined {
  for (let e = error, depth = 0; e instanceof Error && depth < 20; e = e.cause, depth++)
    if (e.name === name) return e;
  return undefined;
}

type ReadFn =
  | "frozen"
  | "mode"
  | "breachCount"
  | "agent"
  | "guardian"
  | "mandateHash"
  | "agentId"
  | "freezeOnBreach";

function isUnsupported(error: unknown): boolean {
  for (let e = error, depth = 0; e instanceof Error && depth < 20; e = e.cause, depth++) {
    if ((e as { code?: unknown }).code === -32601) return true;
    if (/method not found|does not exist|is not available|not supported/i.test(e.message))
      return true;
  }
  return false;
}
