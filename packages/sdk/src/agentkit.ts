import {
  type Action,
  ActionProvider,
  EvmWalletProvider,
  type Network,
  type WalletProvider,
} from "@coinbase/agentkit";
import { mandateVaultAbi } from "@bonded/shared";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  isAddressEqual,
  type PublicClient,
  stringToBytes,
  type TransactionReceipt,
  type TransactionRequest,
} from "viem";
import { readExecuteOutcome } from "./breaches.js";
import { BlockedByMandateError, BondedError, VaultFrozenError } from "./errors.js";
import { type GuardOptions, GuardedVault } from "./guarded.js";
import { vaultRevertError } from "./revert.js";
import type { MessageSigner } from "./sentinel.js";
import { zod3FromJsonSchema } from "./json-schema-zod3.js";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools, resultText } from "./mcp.js";
import { BondedVault } from "./vault.js";

export interface BondedWalletProviderOptions {
  /**
   * A wallet provider for the vault's agent key, e.g. AgentKit's `ViemWalletProvider`. It signs,
   * pays gas and reads the chain; it never holds the funds.
   */
  wallet: EvmWalletProvider;
  /** The Mandate Vault (or MandateModule) whose agent key `wallet` is. */
  vault: Address;
  /**
   * Where the funds are, which AgentKit sees as the wallet's address: the vault itself, or a
   * module's smart account. `BondedWalletProvider.create` reads it from the chain.
   */
  holder?: Address;
  /**
   * Check each transaction before sending it: a dry run of the vault's `execute`, refused on a
   * predicted breach, and Sentinel if configured. Off by default: the vault judges either way.
   */
  guard?: boolean | GuardOptions;
}

/**
 * A Coinbase AgentKit wallet provider whose wallet is a Mandate Vault. Every transaction an
 * action provider sends becomes `vault.execute(to, data)` from the agent key, so the vault checks
 * it against the mandate and records any breach; `getAddress()` is where the funds
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
  /** Where the funds are: the vault, or a module's smart account. */
  readonly holder: Address;
  readonly #wallet: EvmWalletProvider;
  readonly #guard: GuardedVault | undefined;

  constructor(options: BondedWalletProviderOptions) {
    super();
    this.vault = getAddress(options.vault);
    this.holder = getAddress(options.holder ?? options.vault);
    this.#wallet = options.wallet;
    if (options.guard) {
      const reader = new BondedVault({
        vault: this.vault,
        publicClient: options.wallet.getPublicClient() as unknown as PublicClient,
        // Dry runs simulate from the agent key; sending goes through `wallet`.
        account: { address: getAddress(options.wallet.getAddress()), type: "json-rpc" },
      });
      const guard = options.guard === true ? {} : options.guard;
      // Sentinel checks must be signed by the agent key: that is the AgentKit wallet, not the
      // address-only account the reader simulates from (which can't sign).
      const sentinel = guard.sentinel && {
        ...guard.sentinel,
        account: guard.sentinel.account ?? agentKitSigner(options.wallet),
      };
      this.#guard = new GuardedVault(reader, sentinel ? { ...guard, sentinel } : guard);
    }
  }

  /**
   * A provider for a vault or a module, with `holder` read from the chain (a module's funds are
   * in its smart account). Use this for modules; `new` assumes a vault unless `holder` is given.
   */
  static async create(options: BondedWalletProviderOptions): Promise<BondedWalletProvider> {
    if (options.holder) return new BondedWalletProvider(options);
    const reader = new BondedVault({
      vault: options.vault,
      publicClient: options.wallet.getPublicClient() as unknown as PublicClient,
    });
    const { holder } = await reader.identify();
    return new BondedWalletProvider({ ...options, holder });
  }

  getAddress(): string {
    return this.holder;
  }

  getNetwork(): Network {
    return this.#wallet.getNetwork();
  }

  getName(): string {
    return "bonded_vault_wallet_provider";
  }

  /** The native balance where the funds are. The mandate covers ERC-20 tokens; gas is paid by the agent key. */
  async getBalance(): Promise<bigint> {
    return this.#wallet.getPublicClient().getBalance({ address: this.holder });
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

/**
 * Signs EIP-191 messages with an AgentKit wallet. Text is passed as its UTF-8 bytes, so a
 * message that happens to look like hex is still signed as text.
 */
export function agentKitSigner(wallet: EvmWalletProvider): MessageSigner {
  return {
    signMessage: ({ message }) =>
      wallet.signMessage(
        typeof message === "string"
          ? stringToBytes(message)
          : typeof message.raw === "string"
            ? hexToBytes(message.raw)
            : message.raw,
      ),
  };
}

function bypass(what: string): BondedError {
  return new BondedError(
    "UNSUPPORTED",
    `the vault holds the funds and can't sign ${what}; a signature from the agent key would act outside the vault`,
  );
}

/**
 * An AgentKit action provider whose actions are the episode's tools, named
 * `BondedEpisodeActionProvider_<tool>` as AgentKit names its own. Each action returns what the
 * Arena returned, as text; a failed call returns `Error: ...` so the model can react. Works on
 * any network and with any wallet provider: the tools don't use the wallet.
 *
 * In tools mode the episode's writes (`swap`, `transfer`, `approve`) are tools too. In chain mode
 * only the reads are, and writes are transactions to the episode vault: use a
 * `BondedWalletProvider` for `episode.vault` with `episode.sessionKey` and `episode.endpoints.rpc`.
 */
export class BondedEpisodeActionProvider extends ActionProvider<WalletProvider> {
  readonly #episode: EpisodeTools;

  constructor(episode: EpisodeTools) {
    super("bonded_episode", []);
    this.#episode = episode;
  }

  override getActions(): Action[] {
    return this.#episode.tools.map((t) => ({
      name: `BondedEpisodeActionProvider_${t.name}`,
      description: t.description,
      schema: zod3FromJsonSchema(t.inputSchema) as unknown as Action["schema"],
      invoke: async (args: Record<string, unknown>) => resultText(await t.call(args ?? {})),
    }));
  }

  supportsNetwork(): boolean {
    return true;
  }
}

/**
 * The episode's tools as an AgentKit action provider. With no argument it reads the episode from
 * the runner's `BONDED_*` variables. Switch to it only while being rated:
 *
 * ```ts
 * const actionProviders = isBondedEpisode()
 *   ? [await bondedEpisodeActionProvider()]
 *   : [erc20ActionProvider(), myProviders()];
 * const kit = await AgentKit.from({ walletProvider, actionProviders });
 * ```
 */
export async function bondedEpisodeActionProvider(
  from?: EpisodeTools | EpisodeToolsSource,
): Promise<BondedEpisodeActionProvider> {
  return new BondedEpisodeActionProvider(await resolveTools(from));
}
