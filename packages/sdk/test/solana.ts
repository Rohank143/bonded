import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  address,
  createVaultInstruction,
  depositInstruction,
  PROGRAM_IDS,
  TOKEN_PROGRAM,
} from "@bonded/solana";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";

/** The vault program as `pnpm solana:build` writes it. */
export const VAULT_SO = fileURLToPath(
  new URL("../../../contracts/solana/target/deploy/bonded_vault.so", import.meta.url),
);

/**
 * Why the Solana tests can't run here, or undefined if they can: they need the built vault
 * program and Solana's local validator (`solana-test-validator`, from the Solana CLI).
 */
export function solanaSkipReason(): string | undefined {
  if (!existsSync(VAULT_SO)) return "build the Solana programs first: pnpm solana:build";
  if (spawnSync("solana-test-validator", ["--version"]).status !== 0)
    return "install the Solana CLI (solana-test-validator)";
  return undefined;
}

/** A local validator with the vault program loaded, on free ports, in a temporary ledger. */
export class LocalValidator {
  private constructor(
    private readonly process: ChildProcess,
    private readonly ledger: string,
    readonly url: string,
    readonly connection: Connection,
  ) {}

  static async start(): Promise<LocalValidator> {
    // The validator serves websockets (used to confirm transactions) on the RPC port + 1.
    const rpc = await freePortPair();
    const others = new Set([rpc, rpc + 1]);
    const port = async () => {
      for (;;) {
        const p = await freePort();
        if (!others.has(p)) return (others.add(p), p);
      }
    };
    const [faucet, gossip] = [await port(), await port()];
    const ledger = mkdtempSync(join(tmpdir(), "bonded-sdk-validator-"));
    const child = spawn(
      "solana-test-validator",
      [
        "--ledger",
        ledger,
        "--reset",
        "--quiet",
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        String(rpc),
        "--faucet-port",
        String(faucet),
        "--gossip-port",
        String(gossip),
        "--bpf-program",
        PROGRAM_IDS.vault.toBase58(),
        VAULT_SO,
      ],
      { stdio: "ignore" },
    );
    const failed = new Promise<never>((_, reject) =>
      child.once("error", (e) =>
        reject(new Error(`could not start solana-test-validator (Solana CLI): ${e.message}`)),
      ),
    );
    const url = `http://127.0.0.1:${rpc}`;
    const connection = new Connection(url, "confirmed");
    const validator = new LocalValidator(child, ledger, url, connection);
    try {
      await Promise.race([failed, validator.waitUntilReady()]);
    } catch (error) {
      await validator.stop();
      throw error;
    }
    return validator;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) throw new Error("solana-test-validator exited");
      try {
        if ((await this.connection.getSlot()) > 0) return;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("solana-test-validator did not start within 60 seconds");
  }

  /** A new key with test SOL. */
  async fundedKey(): Promise<Keypair> {
    const key = Keypair.generate();
    const signature = await this.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL);
    const latest = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return key;
  }

  async stop(): Promise<void> {
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill();
      await exited;
    }
    rmSync(this.ledger, { recursive: true, force: true });
  }
}

export interface SolanaTestVault {
  vault: PublicKey;
  mint: PublicKey;
  guardian: Keypair;
}

/**
 * A vault for `agent` holding 500 tokens (6 decimals) of a new mint, allowed to call the SPL
 * Token program, with a per-call outflow limit of 1,000 tokens.
 */
export async function createSolanaVault(
  validator: LocalValidator,
  agent: PublicKey,
  options: { enforce?: boolean; agentId?: bigint } = {},
): Promise<SolanaTestVault> {
  const { connection } = validator;
  const guardian = await validator.fundedKey();
  const mint = await createMint(connection, guardian, guardian.publicKey, null, 6);
  const agentId = options.agentId ?? 1n;
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createVaultInstruction(guardian.publicKey, mint, {
        agentId,
        agent,
        mandateHash: new Uint8Array(32),
        enforce: options.enforce ?? false,
        freezeOnBreach: true,
        allowedPrograms: [TOKEN_PROGRAM],
        maxOutflowPerCall: 1_000_000_000n,
      }),
    ),
    [guardian],
  );
  const vault = address.vault(guardian.publicKey, agentId);
  const funding = await getOrCreateAssociatedTokenAccount(
    connection,
    guardian,
    mint,
    guardian.publicKey,
  );
  await mintTo(connection, guardian, mint, funding.address, guardian, 1_000_000_000n);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      depositInstruction(
        { address: vault, baseMint: mint },
        funding.address,
        guardian.publicKey,
        500_000_000n,
      ),
    ),
    [guardian],
  );
  return { vault, mint, guardian };
}

/** A free port whose next port is free too. */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort();
    if (port < 65535 && (await freePort(port + 1).catch(() => undefined))) return port;
  }
  throw new Error("no free pair of ports");
}

async function freePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      server.close(() =>
        typeof a === "object" && a ? resolve(a.port) : reject(new Error("no free port")),
      );
    });
  });
}
