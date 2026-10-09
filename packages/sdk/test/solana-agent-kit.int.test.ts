import { address, fetchVault, TOKEN_PROGRAM } from "@bondedhq/solana";
import { createAssociatedTokenAccountIdempotentInstruction, getAccount } from "@solana/spl-token";
import { type Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { executeAction, KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  associatedTokenAddress,
  bondedVaultPlugin,
  type SolanaSwapBuilder,
} from "../src/solana-agent-kit.js";
import { createSolanaVault, LocalValidator, solanaSkipReason } from "./solana.js";

const skip = solanaSkipReason();
if (skip) console.warn(`Skipping the Solana Agent Kit tests: ${skip}`);

describe.skipIf(skip)("Solana Agent Kit plugin on a local validator", () => {
  let validator: LocalValidator;
  let agentKey: Keypair;
  const attacker = PublicKey.unique();

  beforeAll(async () => {
    validator = await LocalValidator.start();
    agentKey = await validator.fundedKey();
  }, 120_000);
  afterAll(async () => {
    await validator?.stop();
  });

  /** Solana Agent Kit with the agent key as its wallet and the plugin for `vault`. */
  function kit(vault: PublicKey, guard = false) {
    const agent = new SolanaAgentKit(new KeypairWallet(agentKey, validator.url), validator.url, {});
    const withPlugin = agent.use(bondedVaultPlugin({ vault, guard }));
    const action = (name: string) => {
      const found = withPlugin.actions.find((a) => a.name === name);
      if (!found) throw new Error(`no action ${name}`);
      return (input: Record<string, unknown>) => executeAction(found, withPlugin, input);
    };
    return { agent: withPlugin, action };
  }
  const balance = async (owner: PublicKey, mint: PublicKey) =>
    (await getAccount(validator.connection, associatedTokenAddress(owner, mint), "confirmed"))
      .amount;

  it("moves tokens within the vault, and records a transfer out as a breach (Monitor)", async () => {
    const v = await createSolanaVault(validator, agentKey.publicKey);
    const { action } = kit(v.vault);
    const transfer = action("BONDED_VAULT_TRANSFER");

    // Allowed: into the vault's own token account.
    const allowed = await transfer({
      mint: v.mint.toBase58(),
      to: v.vault.toBase58(),
      amount: "100",
    });
    expect(allowed).toMatchObject({ status: "success", breaches: [] });
    expect(await balance(v.vault, v.mint)).toBe(100_000_000n);
    expect((await fetchVault(validator.connection, v.vault, "confirmed"))?.breaches).toEqual([]);

    // Out of the vault: Monitor mode lets it through, records it and freezes the agent.
    const out = await transfer({ mint: v.mint.toBase58(), to: attacker.toBase58(), amount: "25" });
    expect(out).toMatchObject({
      status: "success",
      breaches: [{ breachId: 0, type: "UnauthorizedTransfer", blocked: false, loss: "25000000" }],
    });
    expect(await balance(attacker, v.mint)).toBe(25_000_000n);
    const state = await fetchVault(validator.connection, v.vault, "confirmed");
    expect(state?.frozen).toBe(true);
    expect(state?.breaches.map((b) => [b.type, b.blocked, b.loss])).toEqual([
      ["UnauthorizedTransfer", false, 25_000_000n],
    ]);

    // Frozen: the program refuses, and the action says why.
    const next = await transfer({ mint: v.mint.toBase58(), to: v.vault.toBase58(), amount: "1" });
    expect(next).toMatchObject({ status: "error", code: "VAULT_FROZEN" });
    expect(await action("BONDED_VAULT_STATUS")({})).toMatchObject({
      status: "success",
      frozen: true,
      mode: "monitor",
      breaches: [{ id: 0, type: "UnauthorizedTransfer", blocked: false }],
    });
  }, 120_000);

  it("blocks a transfer out in Enforce mode: the attempt is recorded, nothing moves", async () => {
    const v = await createSolanaVault(validator, agentKey.publicKey, {
      enforce: true,
      agentId: 2n,
    });
    const { action } = kit(v.vault);
    const outsider = PublicKey.unique();
    const result = await action("BONDED_VAULT_TRANSFER")({
      mint: v.mint.toBase58(),
      to: outsider.toBase58(),
      amount: "40",
    });
    expect(result).toMatchObject({ status: "error", code: "BLOCKED_BY_MANDATE" });
    const state = await fetchVault(validator.connection, v.vault, "confirmed");
    expect(state?.breaches.map((b) => [b.type, b.blocked, b.loss])).toEqual([
      ["UnauthorizedTransfer", true, 0n],
    ]);
    expect(await balance(outsider, v.mint)).toBe(0n);
    // The vault's base account still holds the whole deposit.
    const base = await getAccount(validator.connection, address.vaultBase(v.vault), "confirmed");
    expect(base.amount).toBe(500_000_000n);
  }, 120_000);

  it("with the guard, refuses a predicted breach before sending it", async () => {
    const v = await createSolanaVault(validator, agentKey.publicKey, { agentId: 3n });
    const { agent } = kit(v.vault, true);
    await expect(
      agent.methods.bondedVaultTransfer(agent, { mint: v.mint, to: attacker, amount: 1n }),
    ).rejects.toMatchObject({ code: "PREDICTED_BREACH", breach: { type: "UnauthorizedTransfer" } });
    expect((await fetchVault(validator.connection, v.vault, "confirmed"))?.breaches).toEqual([]);
    // An allowed transfer passes the guard.
    const ok = await agent.methods.bondedVaultTransfer(agent, {
      mint: v.mint,
      to: v.vault,
      amount: 5n,
    });
    expect(ok.breaches).toEqual([]);
  }, 120_000);

  it("runs a swap from the configured builder inside the vault's execute", async () => {
    const v = await createSolanaVault(validator, agentKey.publicKey, { agentId: 4n });
    // A stand-in for a DEX route (e.g. Jupiter's swap-instructions): a transfer between the
    // vault's own accounts, so the test needs no DEX on the local validator.
    const builder: SolanaSwapBuilder = async ({ vault, inputMint, amount }) => {
      const data = Buffer.alloc(10);
      data.writeUInt8(12, 0);
      data.writeBigUInt64LE(amount, 1);
      data.writeUInt8(6, 9);
      const destination = associatedTokenAddress(vault, inputMint);
      return {
        setup: [
          createAssociatedTokenAccountIdempotentInstruction(
            agentKey.publicKey,
            destination,
            vault,
            inputMint,
          ),
        ],
        instruction: new TransactionInstruction({
          programId: TOKEN_PROGRAM,
          data,
          keys: [
            { pubkey: address.vaultBase(vault), isSigner: false, isWritable: true },
            { pubkey: inputMint, isSigner: false, isWritable: false },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: true, isWritable: false },
          ],
        }),
      };
    };
    const agent = new SolanaAgentKit(new KeypairWallet(agentKey, validator.url), validator.url, {});
    const withPlugin = agent.use(bondedVaultPlugin({ vault: v.vault, swap: builder }));
    const swap = withPlugin.actions.find((a) => a.name === "BONDED_VAULT_SWAP")!;
    const result = await executeAction(swap, withPlugin, {
      inputMint: v.mint.toBase58(),
      outputMint: v.mint.toBase58(),
      amount: "7.5",
    });
    expect(result).toMatchObject({ status: "success", breaches: [] });
    expect(await balance(v.vault, v.mint)).toBe(7_500_000n);
  }, 120_000);
});
