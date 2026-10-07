import { EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { mandateVaultAbi } from "@bonded/shared";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  isAddressEqual,
  type PublicClient,
  type TransactionReceipt,
  type TransactionRequest,
} from "viem";
import { readExecuteOutcome } from "./breaches.js";
import { BlockedByMandateError, BondedError, VaultFrozenError } from "./errors.js";
import { type GuardOptions, GuardedVault } from "./guarded.js";
import { vaultRevertError } from "./revert.js";
import { BondedVault } from "./vault.js";

export interface BondedWalletProviderOptions {
  /**
   * A wallet provider for the vault's agent key, e.g. AgentKit's `ViemWalletProvider`. It signs,
   * pays gas and reads the chain; it never holds the funds.
   */
  wallet: EvmWalletProvider;
  /** The Mandate Vault that holds the funds and whose agent key `wallet` is. */
  vault: Address;
  /**
   * Check each transaction before sending it: a dry run of the vault's `execute`, refused on a
   * predicted breach, and Sentinel if configured. Off by default: the vault judges either way.
   */
  guard?: boolean | GuardOptions;
}

/**
 * A Coinbase AgentKit wallet provider whose wallet is a Mandate Vault. Every transaction an
 * action provider sends becomes `vault.execute(to, data)` from the agent key, so the vault checks
 * it against the mandate and records any breach; `getAddress()` is the vault, where the funds
 * are. Any AgentKit action provider then trades through the mandate unchanged.
 *
 * What a vault can't do is refused: native value (the vault is ERC-20 only), contract creation,
 * and raw signatures or signed transactions from the agent key, which would bypass the vault.
 * `signMessage` signs with the agent key (e.g. for API logins); it is not the vault's signature.
 *
 * In Enforce mode a blocked transaction still mines; `waitForTransactionReceipt` throws
 * `BlockedByMandateError` for it, so the action reports a failure instead of a success.
 */
export class BondedWalletProvider extends EvmWalletProvider {
  readonly vault: Address;
  readonly #wallet: EvmWalletProvider;
  readonly #guard: GuardedVault | undefined;

  constructor(options: BondedWalletProviderOptions) {
    super();
    this.vault = getAddress(options.vault);
    this.#wallet = options.wallet;
    if (options.guard) {
      const reader = new BondedVault({
        vault: this.vault,
        publicClient: options.wallet.getPublicClient() as unknown as PublicClient,
        // Dry runs simulate from the agent key; sending goes through `wallet`.
        account: { address: getAddress(options.wallet.getAddress()), type: "json-rpc" },
      });
      this.#guard = new GuardedVault(reader, options.guard === true ? {} : options.guard);
    }
  }

  getAddress(): string {
    return this.vault;
  }

  getNetwork(): Network {
    return this.#wallet.getNetwork();
  }

  getName(): string {
    return "bonded_vault_wallet_provider";
  }

  /** The vault's native balance. The vault holds ERC-20 tokens; gas is paid by the agent key. */
  async getBalance(): Promise<bigint> {
    return this.#wallet.getPublicClient().getBalance({ address: this.vault });
  }

  getPublicClient(): ReturnType<EvmWalletProvider["getPublicClient"]> {
    return this.#wallet.getPublicClient();
  }

  // Generic in its parameters: AgentKit types this with its own copy of viem.
  readContract<P>(params: P): Promise<never> {
    return this.#wallet.readContract(params as never) as Promise<never>;
  }

  /** Sends `transaction` as `vault.execute(to, data)` from the agent key. */
  async sendTransaction(transaction: TransactionRequest): Promise<Hex> {
    if (transaction.value !== undefined && BigInt(transaction.value) > 0n)
      throw new BondedError(
        "NATIVE_VALUE",
        "the Mandate Vault holds ERC-20 tokens only; it can't send native value",
      );
    if (!transaction.to)
      throw new BondedError("UNSUPPORTED", "the Mandate Vault can't deploy contracts");
    const target = getAddress(transaction.to);
    const data = transaction.data ?? "0x";
    await this.#guard?.check({ type: "call", target, data });
    try {
      return await this.#wallet.sendTransaction({
        to: this.vault,
        data: encodeFunctionData({
          abi: mandateVaultAbi,
          functionName: "execute",
          args: [target, data],
        }),
      });
    } catch (error) {
      throw vaultRevertError(error, {
        vault: this.vault,
        target,
        signer: getAddress(this.#wallet.getAddress()),
      });
    }
  }

  /**
   * Waits for the transaction, then reads the vault's verdict from its events: throws
   * `BlockedByMandateError` when Enforce mode stopped the call, `VaultFrozenError` when a
   * freeze skipped it. A Monitor-mode breach goes through and is in the vault's breach log.
   */
  async waitForTransactionReceipt(txHash: Hex): Promise<TransactionReceipt> {
    const receipt = (await this.#wallet.waitForTransactionReceipt(txHash)) as TransactionReceipt;
    if (!receipt.to || !isAddressEqual(receipt.to, this.vault)) return receipt;
    const outcome = readExecuteOutcome(this.vault, receipt.logs);
    if (receipt.status === "success" && !outcome.executed) {
      const blocked = outcome.breaches.find((b) => b.blocked);
      if (blocked) throw new BlockedByMandateError(blocked, txHash);
      throw new VaultFrozenError(this.vault, outcome.breaches[0], txHash);
    }
    return receipt;
  }

  async nativeTransfer(): Promise<Hex> {
    throw new BondedError(
      "NATIVE_VALUE",
      "the Mandate Vault holds ERC-20 tokens only; it can't send native value",
    );
  }

  /** Signs with the agent key. This is not a signature by the vault. */
  signMessage(message: string | Uint8Array): Promise<Hex> {
    return this.#wallet.signMessage(message);
  }

  async sign(): Promise<Hex> {
    throw bypass("raw hashes");
  }

  async signTypedData(): Promise<Hex> {
    throw bypass("typed data (e.g. permits)");
  }

  async signTransaction(): Promise<Hex> {
    throw bypass("transactions");
  }
}

function bypass(what: string): BondedError {
  return new BondedError(
    "UNSUPPORTED",
    `the vault holds the funds and can't sign ${what}; a signature from the agent key would act outside the vault`,
  );
}
