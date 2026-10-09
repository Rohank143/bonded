import {
  type BreachEvent,
  breachEventsFromLogs,
  executeInstruction,
  fetchVault,
  TOKEN_PROGRAM,
  type VaultAccount,
  vaultError,
} from "@bondedhq/solana";
import {
  type AddressLookupTableAccount,
  type Connection,
  PublicKey,
  SystemProgram,
  type Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { z } from "zod/v3";
import { BondedError } from "./errors.js";

/**
 * Bonded's Solana vault (`bonded_vault`) for Solana Agent Kit. What the program checks (its
 * `classify`), and so what this plugin can do:
 *
 * - The called program must be on the vault's allowlist (T1 target).
 * - SPL `Transfer`/`TransferChecked` must go to a token account the vault owns (T1 transfer).
 *   There is no destination allowlist on Solana: any transfer out of the vault is a breach.
 * - `Approve`, `ApproveChecked`, `SetAuthority` and `CloseAccount` are never allowed.
 * - The net base-asset outflow of one call must not exceed the vault's limit (T2).
 * - No T3 (price) check yet, and no 24h limit.
 *
 * One instruction per `execute`, called by CPI with the vault as signer, so CPI depth and the
 * compute budget limit what can run (Jupiter multi-hop routes may not fit).
 */

/** A breach the vault recorded (or would record), from its `BreachRecorded` event. */
export type SolanaVaultBreach = BreachEvent;

/** What a vault action did. Monitor mode lets breaches through: check `breaches`. */
export interface SolanaActionResult {
  signature: string;
  breaches: SolanaVaultBreach[];
}

/** What the vault would do with an instruction, from simulating `execute`. */
export interface SolanaDryRunResult {
  /** The vault would run it and record no breach. */
  ok: boolean;
  /** Enforce mode would stop it. */
  blocked: boolean;
  breach?: SolanaVaultBreach;
  breaches: SolanaVaultBreach[];
}

/** An error from the Solana vault, with the breach when the vault recorded one. */
export class SolanaVaultError extends BondedError {
  override readonly name = "SolanaVaultError";
  constructor(
    code: string,
    message: string,
    readonly breach?: SolanaVaultBreach,
    readonly signature?: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

/** Signs transactions as the vault's agent key. Solana Agent Kit's wallets are this. */
export interface SolanaSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
}

/** Builds a swap where the vault owns the tokens, e.g. from Jupiter's swap-instructions API. */
export type SolanaSwapBuilder = (params: {
  vault: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  /** In `inputMint` base units. */
  amount: bigint;
  slippageBps: number;
}) => Promise<{
  /** The swap, with the vault as the token authority. It runs inside the vault's `execute`. */
  instruction: TransactionInstruction;
  /** Instructions the agent key runs first, outside the vault (e.g. creating token accounts). */
  setup?: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
}>;

/** Solana Agent Kit validates with zod 3; `zod/v3` is that API, typed at this boundary. */
const schema = (shape: z.ZodRawShape) => z.object(shape) as unknown as Action["schema"];

/** Reads and confirmations use "confirmed": a vault's state must be current to judge an action. */
const COMMITMENT = "confirmed" as const;

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MINT_DECIMALS_OFFSET = 44;

/** The associated token account of `owner` for `mint` (the vault, a PDA, included). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/**
 * A Bonded vault on Solana, from the agent's side. Every action is the vault program's
 * `execute`, signed by the agent key.
 */
export class SolanaBondedVault {
  readonly address: PublicKey;

  constructor(
    readonly connection: Connection,
    vault: PublicKey | string,
    readonly agent: SolanaSigner,
  ) {
    this.address = new PublicKey(vault);
  }

  async status(): Promise<VaultAccount> {
    const vault = await fetchVault(this.connection, this.address, COMMITMENT);
    if (!vault) throw new BondedError("NOT_FOUND", `no Bonded vault at ${this.address.toBase58()}`);
    return vault;
  }

  /**
   * Send `amount` (base units) of `mint` from the vault to `to`'s associated token account,
   * creating it (paid by the agent key) if it doesn't exist. Only a transfer to the vault's own
   * account keeps to the mandate on Solana.
   */
  async transfer(params: { mint: PublicKey; to: PublicKey; amount: bigint }) {
    const plan = await this.transferPlan(params);
    return this.execute(plan.instruction, plan.setup);
  }

  /** Runs `inner` through the vault's `execute`, after any `setup` the agent key runs itself. */
  async execute(
    inner: TransactionInstruction,
    setup: TransactionInstruction[] = [],
    lookupTables: AddressLookupTableAccount[] = [],
  ): Promise<SolanaActionResult> {
    const { transaction, blockhash, lastValidBlockHeight } = await this.build(
      inner,
      setup,
      lookupTables,
    );
    const signed = await this.agent.signTransaction(transaction);
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: COMMITMENT,
      });
    } catch (error) {
      throw this.programError(error);
    }
    const confirmed = await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      COMMITMENT,
    );
    if (confirmed.value.err)
      throw this.programError(confirmed.value.err, `transaction ${signature} failed`);
    const tx = await this.connection.getTransaction(signature, {
      commitment: COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
    const breaches = breachEventsFromLogs(tx?.meta?.logMessages ?? []);
    const blocked = breaches.find((b) => b.blocked);
    if (blocked)
      throw new SolanaVaultError(
        "BLOCKED_BY_MANDATE",
        `the vault blocked this action (${blocked.type}); the attempt is recorded as breach ${blocked.breachId}`,
        blocked,
        signature,
      );
    return { signature, breaches };
  }

  /** What the vault would do with `inner`: simulates `execute` against the cluster's state. */
  async dryRun(
    inner: TransactionInstruction,
    setup: TransactionInstruction[] = [],
    lookupTables: AddressLookupTableAccount[] = [],
  ): Promise<SolanaDryRunResult> {
    const { transaction } = await this.build(inner, setup, lookupTables);
    const { value } = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: COMMITMENT,
    });
    if (value.err) throw this.programError(value.err, "the simulation failed", value.logs);
    const breaches = breachEventsFromLogs(value.logs ?? []);
    return {
      ok: breaches.length === 0,
      blocked: breaches.some((b) => b.blocked),
      ...(breaches[0] ? { breach: breaches[0] } : {}),
      breaches,
    };
  }

  /**
   * The SPL `TransferChecked` the vault would sign for `transfer`, and the account creation the
   * agent key runs first if needed. Pass both to `dryRun` to preview a transfer.
   */
  async transferPlan(params: { mint: PublicKey; to: PublicKey; amount: bigint }) {
    const vault = await this.status();
    const source = params.mint.equals(vault.baseMint)
      ? vault.baseAccount
      : associatedTokenAddress(this.address, params.mint);
    const destination = associatedTokenAddress(params.to, params.mint);
    const setup = (await this.connection.getAccountInfo(destination, COMMITMENT))
      ? []
      : [createAtaIdempotent(this.agent.publicKey, destination, params.to, params.mint)];
    const decimals = await mintDecimals(this.connection, params.mint);
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); // TransferChecked
    data.writeBigUInt64LE(params.amount, 1);
    data.writeUInt8(decimals, 9);
    const instruction = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      data,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: this.address, isSigner: true, isWritable: false },
      ],
    });
    return { instruction, setup };
  }

  private async build(
    inner: TransactionInstruction,
    setup: TransactionInstruction[],
    lookupTables: AddressLookupTableAccount[],
  ) {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash(COMMITMENT);
    const execute = executeInstruction(
      { address: this.address, agent: this.agent.publicKey },
      inner,
    );
    const message = new TransactionMessage({
      payerKey: this.agent.publicKey,
      recentBlockhash: blockhash,
      instructions: [...setup, execute],
    }).compileToV0Message(lookupTables);
    return { transaction: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
  }

  /** Names the vault program's error when the failure is one, e.g. a frozen vault. */
  private programError(error: unknown, context?: string, logs?: string[] | null): BondedError {
    const code = customErrorCode(error);
    const named = code !== undefined ? vaultError(code) : undefined;
    if (named)
      return new SolanaVaultError(
        named.name === "Frozen"
          ? "VAULT_FROZEN"
          : named.name === "NotAgent"
            ? "NOT_AGENT"
            : "VAULT_ERROR",
        named.message,
        undefined,
        undefined,
        { cause: error },
      );
    const detail = logs?.length ? `\n${logs.join("\n")}` : "";
    const what = error instanceof Error ? error.message : JSON.stringify(error);
    return new BondedError(
      "CALL_REVERTED",
      `${context ?? "the transaction failed"}: ${what}${detail}`,
      {
        cause: error,
      },
    );
  }
}

/** The custom program error code in a transaction error, from its JSON or its message. */
function customErrorCode(error: unknown): number | undefined {
  const json = /"Custom":(\d+)/.exec(JSON.stringify(error) ?? "");
  if (json) return Number(json[1]);
  const message = error instanceof Error ? error.message : "";
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(message);
  return hex ? parseInt(hex[1]!, 16) : undefined;
}

function createAtaIdempotent(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]), // CreateIdempotent
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
}

async function mintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint, COMMITMENT);
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length <= MINT_DECIMALS_OFFSET)
    throw new BondedError("INVALID_ACTION", `${mint.toBase58()} is not an SPL token mint`);
  return info.data[MINT_DECIMALS_OFFSET]!;
}

/** Whole units (e.g. "12.5") to base units, refusing more decimals than the mint has. */
function toBaseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match || (match[2]?.length ?? 0) > decimals)
    throw new BondedError(
      "INVALID_ACTION",
      `"${amount}" is not an amount with at most ${decimals} decimals`,
    );
  return BigInt(match[1]! + (match[2] ?? "").padEnd(decimals, "0"));
}

export interface BondedSolanaPluginOptions {
  /** The vault account (the PDA from `address.vault(guardian, agentId)`). */
  vault: PublicKey | string;
  /** Simulate each action first and refuse a predicted breach. Default false: the vault judges. */
  guard?: boolean;
  /** Enables `BONDED_VAULT_SWAP`; without it the plugin has no swap. */
  swap?: SolanaSwapBuilder;
}

/**
 * A Solana Agent Kit plugin whose transfer and swap go through a Bonded vault. The kit's wallet
 * must be the vault's agent key. Methods (`agent.methods.*`) take base units; actions take whole
 * units, as an LLM writes them.
 */
export function bondedVaultPlugin(options: BondedSolanaPluginOptions) {
  const vaults = new WeakMap<SolanaAgentKit, SolanaBondedVault>();
  const vaultFor = (agent: SolanaAgentKit) => {
    let vault = vaults.get(agent);
    if (!vault) {
      vault = new SolanaBondedVault(agent.connection, options.vault, agent.wallet);
      vaults.set(agent, vault);
    }
    return vault;
  };
  const guarded = async (
    vault: SolanaBondedVault,
    inner: TransactionInstruction,
    setup: TransactionInstruction[] = [],
    lookupTables: AddressLookupTableAccount[] = [],
  ) => {
    if (options.guard) {
      const check = await vault.dryRun(inner, setup, lookupTables);
      if (!check.ok)
        throw new SolanaVaultError(
          "PREDICTED_BREACH",
          `refused: the vault would record a breach (${check.breach?.type})`,
          check.breach,
        );
    }
    return vault.execute(inner, setup, lookupTables);
  };

  const methods = {
    /** The vault's account: mode, frozen, allowed programs, limit and breach log. */
    bondedVaultStatus: (agent: SolanaAgentKit) => vaultFor(agent).status(),
    bondedVaultTransfer: async (
      agent: SolanaAgentKit,
      params: { mint: PublicKey; to: PublicKey; amount: bigint },
    ): Promise<SolanaActionResult> => {
      const vault = vaultFor(agent);
      const plan = await vault.transferPlan(params);
      return guarded(vault, plan.instruction, plan.setup);
    },
    bondedVaultSwap: async (
      agent: SolanaAgentKit,
      params: { inputMint: PublicKey; outputMint: PublicKey; amount: bigint; slippageBps?: number },
    ): Promise<SolanaActionResult> => {
      if (!options.swap)
        throw new BondedError(
          "CONFIG",
          "set `swap` in bondedVaultPlugin to swap through the vault",
        );
      const vault = vaultFor(agent);
      const built = await options.swap({
        vault: vault.address,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: params.slippageBps ?? 50,
      });
      return guarded(vault, built.instruction, built.setup, built.lookupTables);
    },
    /** Any instruction with the vault as signer, through `execute`. */
    bondedVaultExecute: (agent: SolanaAgentKit, instruction: TransactionInstruction) =>
      guarded(vaultFor(agent), instruction),
  };

  const report = (result: SolanaActionResult) => ({
    signature: result.signature,
    breaches: result.breaches.map((b) => ({
      ...b,
      target: b.target.toBase58(),
      loss: b.loss.toString(),
    })),
    message: result.breaches.length
      ? `Done, but the vault recorded a breach (${result.breaches.map((b) => b.type).join(", ")}) and may have frozen the agent.`
      : "Done within the mandate.",
  });

  const transferAction: Action = {
    name: "BONDED_VAULT_TRANSFER",
    similes: ["send tokens from the vault", "transfer from the bonded vault"],
    description:
      "Send SPL tokens from the Bonded vault that holds the agent's funds. The vault checks it against the mandate; on Solana only transfers to the vault's own accounts are allowed.",
    examples: [
      [
        {
          input: {
            mint: "So11111111111111111111111111111111111111112",
            to: "<vault>",
            amount: "1.5",
          },
          output: { status: "success", signature: "5x...", breaches: [] },
          explanation: "Move 1.5 tokens into the vault's own token account",
        },
      ],
    ],
    schema: schema({
      mint: z.string().describe("The token's mint address"),
      to: z.string().describe("The owner of the receiving token account"),
      amount: z.string().describe("Amount in whole tokens, e.g. 12.5"),
    }),
    handler: async (agent, input) => {
      const mint = new PublicKey(input.mint as string);
      const amount = toBaseUnits(
        input.amount as string,
        await mintDecimals(agent.connection, mint),
      );
      return report(
        await methods.bondedVaultTransfer(agent, {
          mint,
          to: new PublicKey(input.to as string),
          amount,
        }),
      );
    },
  };

  const swapAction: Action = {
    name: "BONDED_VAULT_SWAP",
    similes: ["swap tokens in the vault", "trade through the bonded vault"],
    description:
      "Swap tokens held by the Bonded vault. The swap runs inside the vault's execute, which checks the program and the outflow limit.",
    examples: [],
    schema: schema({
      inputMint: z.string(),
      outputMint: z.string(),
      amount: z.string().describe("Amount of the input token in whole tokens"),
      slippageBps: z.number().int().min(0).max(10_000).optional(),
    }),
    handler: async (agent, input) => {
      const inputMint = new PublicKey(input.inputMint as string);
      const amount = toBaseUnits(
        input.amount as string,
        await mintDecimals(agent.connection, inputMint),
      );
      return report(
        await methods.bondedVaultSwap(agent, {
          inputMint,
          outputMint: new PublicKey(input.outputMint as string),
          amount,
          ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps as number } : {}),
        }),
      );
    },
  };

  const statusAction: Action = {
    name: "BONDED_VAULT_STATUS",
    similes: ["vault status", "is the vault frozen"],
    description:
      "Report the Bonded vault's state: whether it is frozen, its mode, the programs it may call, its per-call limit and its breach log.",
    examples: [],
    schema: schema({}),
    handler: async (agent) => {
      const v = await methods.bondedVaultStatus(agent);
      return {
        vault: v.address.toBase58(),
        frozen: v.frozen,
        mode: v.enforce ? "enforce" : "monitor",
        allowedPrograms: v.allowedPrograms.map((p) => p.toBase58()),
        maxOutflowPerCall: v.maxOutflowPerCall.toString(),
        breaches: v.breaches.map((b) => ({
          id: b.id,
          type: b.type,
          blocked: b.blocked,
          loss: b.loss.toString(),
        })),
      };
    },
  };

  return {
    name: "bonded-vault",
    methods,
    actions: [transferAction, statusAction, ...(options.swap ? [swapAction] : [])],
    initialize: () => {},
  } satisfies Plugin;
}
