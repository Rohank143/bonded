import { ANVIL_KEYS } from "@bonded/sandbox";
import { mandateVaultAbi, testTokenAbi } from "@bonded/shared";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlockedByMandateError,
  BondedError,
  BondedVault,
  CallRevertedError,
  NotAgentError,
  VaultFrozenError,
} from "../src/index.js";
import {
  ATTACKER,
  Sandbox,
  balanceOf,
  breachCount,
  createTestVault,
  send,
  type TestVault,
} from "./chain.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
});

const usd = (n: number) => parseUnits(String(n), 6);
const agent = () => privateKeyToAccount(ANVIL_KEYS.agent);

function client(v: TestVault, account = agent()) {
  return new BondedVault({
    vault: v.address,
    // No rpcUrl: the wallet sends through the public client's RPC.
    publicClient: sandbox.publicClient,
    account,
    router: sandbox.deployment.router,
  });
}

describe("a Monitor-mode vault", () => {
  let v: TestVault;
  let vault: BondedVault;
  beforeAll(async () => {
    v = await createTestVault(sandbox);
    vault = client(v);
  });

  it("reports its status from the chain, with the mandate hash the builder made", async () => {
    expect(await vault.status()).toEqual({
      kind: "vault",
      holder: v.address,
      frozen: false,
      mode: "monitor",
      breachCount: 0n,
      agent: sandbox.address("agent"),
      guardian: sandbox.address("operator"),
      mandateHash: v.mandateHash,
      agentId: v.agentId,
      freezeOnBreach: true,
    });
  });

  it("swaps within the mandate: approves the router, swaps, records nothing", async () => {
    const d = sandbox.deployment;
    const swap = { tokenIn: d.usdg, tokenOut: d.tsla, amountIn: usd(1_000) };
    expect(await vault.dryRun({ type: "swap", ...swap })).toEqual({
      ok: true,
      executed: true,
      blocked: false,
      breaches: [],
      wouldFreeze: false,
    });
    const result = await vault.swap(swap);
    expect(result.hashes).toHaveLength(2); // approve, then swap
    expect(result.breaches).toEqual([]);
    expect(await balanceOf(sandbox, d.tsla, v.address)).toBeGreaterThan(0n);
    expect(await balanceOf(sandbox, d.usdg, v.address)).toBe(usd(49_000));
    // The exact approval is used up, so the next swap approves again.
    expect(await vault.plan({ type: "swap", ...swap })).toHaveLength(2);
  });

  it("refuses a swap whose quote is below minOut, before sending anything", async () => {
    const d = sandbox.deployment;
    const before = await balanceOf(sandbox, d.usdg, v.address);
    await expect(
      vault.swap({ tokenIn: d.usdg, tokenOut: d.tsla, amountIn: usd(100), minOut: 10n ** 30n }),
    ).rejects.toMatchObject({ code: "BELOW_MIN_OUT" });
    expect(await balanceOf(sandbox, d.usdg, v.address)).toBe(before);
  });

  it("surfaces a failing call as CallRevertedError and records nothing", async () => {
    const d = sandbox.deployment;
    const transfer = {
      type: "transfer" as const,
      token: d.tsla,
      to: v.address,
      amount: 10n ** 40n,
    };
    await expect(vault.dryRun(transfer)).rejects.toBeInstanceOf(CallRevertedError);
    await expect(vault.execute(transfer)).rejects.toBeInstanceOf(CallRevertedError);
    expect(await breachCount(sandbox, v.address)).toBe(0n);
  });

  it("predicts a breach without recording it, then the vault records exactly that breach", async () => {
    const d = sandbox.deployment;
    const transfer = { token: d.usdg, to: ATTACKER, amount: usd(500) };
    const prediction = await vault.dryRun({ type: "transfer", ...transfer });
    expect(prediction).toMatchObject({
      ok: false,
      executed: true,
      blocked: false,
      wouldFreeze: true,
      breach: { id: 0n, type: "T1_UNAUTHORIZED_TRANSFER", blocked: false, lossUsd6: usd(500) },
    });
    // A dry run changes nothing.
    expect(await breachCount(sandbox, v.address)).toBe(0n);

    // Monitor mode: the transfer goes through and is recorded; the agent is frozen.
    const result = await vault.transfer(transfer);
    expect(result.breaches).toEqual([prediction.breach]);
    expect(await vault.breaches()).toEqual([prediction.breach]);
    expect(await balanceOf(sandbox, d.usdg, ATTACKER)).toBe(usd(500));
    expect((await vault.status()).frozen).toBe(true);
  });

  it("refuses to act once frozen, in a dry run and for real", async () => {
    const d = sandbox.deployment;
    const transfer = { type: "transfer" as const, token: d.usdg, to: v.address, amount: 1n };
    await expect(vault.dryRun(transfer)).rejects.toBeInstanceOf(VaultFrozenError);
    await expect(vault.execute(transfer)).rejects.toBeInstanceOf(VaultFrozenError);
  });
});

describe("an outflow the vault couldn't explain", () => {
  it("freezes the vault before the next action runs, and the SDK says so", async () => {
    const d = sandbox.deployment;
    const v = await createTestVault(sandbox);
    const vault = client(v);
    // Monitor mode lets an approval to an attacker through (recorded, frozen)...
    const approval = await vault.approve({ token: d.usdg, spender: ATTACKER, amount: usd(700) });
    expect(approval.breaches.map((b) => b.type)).toEqual(["T1_UNAUTHORIZED_APPROVAL"]);
    // ...the guardian unfreezes, and the attacker pulls funds outside execute.
    await send(sandbox, "operator", {
      address: v.address,
      abi: mandateVaultAbi,
      functionName: "unfreeze",
      args: [],
    });
    const attacker = await sandbox.impersonate(ATTACKER);
    const hash = await attacker.writeContract({
      address: d.usdg,
      abi: testTokenAbi,
      functionName: "transferFrom",
      args: [v.address, ATTACKER, usd(700)],
    });
    await sandbox.publicClient.waitForTransactionReceipt({ hash });

    // The next action finds the drop first: a deferred breach, a freeze, and the action skipped.
    const action = { type: "transfer" as const, token: d.usdg, to: v.address, amount: 1n };
    expect(await vault.dryRun(action)).toMatchObject({
      ok: false,
      executed: false,
      blocked: false,
      wouldFreeze: true,
      breach: { id: 1n, type: "T1_DEFERRED", lossUsd6: usd(700) },
    });
    const error = await vault.execute(action).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultFrozenError);
    expect((error as VaultFrozenError).breach).toMatchObject({ id: 1n, type: "T1_DEFERRED" });
    expect((error as VaultFrozenError).hash).toMatch(/^0x/);
  });
});

describe("an Enforce-mode vault", () => {
  let v: TestVault;
  let vault: BondedVault;
  beforeAll(async () => {
    v = await createTestVault(sandbox, { mode: "enforce" });
    vault = client(v);
  });

  it("blocks an over-limit swap: predicted, then blocked and recorded with nothing moved", async () => {
    const d = sandbox.deployment;
    const swap = { tokenIn: d.usdg, tokenOut: d.nvda, amountIn: usd(6_000) };
    const prediction = await vault.dryRun({ type: "swap", ...swap });
    expect(prediction).toMatchObject({
      ok: false,
      executed: false,
      blocked: true,
      breach: { type: "T2_LIMIT", blocked: true, lossUsd6: 0n },
    });
    const error = await vault.swap(swap).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedByMandateError);
    const blocked = error as BlockedByMandateError;
    expect(blocked.breach).toMatchObject({ type: "T2_LIMIT", blocked: true });
    expect(await vault.breaches()).toEqual([blocked.breach]);
    expect(await balanceOf(sandbox, d.usdg, v.address)).toBe(usd(50_000));
    expect(await balanceOf(sandbox, d.nvda, v.address)).toBe(0n);
  });
});

describe("keys and configuration", () => {
  let v: TestVault;
  beforeAll(async () => {
    v = await createTestVault(sandbox);
  });

  it("rejects a key that isn't the vault's agent, before and when sending", async () => {
    const vault = client(v, privateKeyToAccount(ANVIL_KEYS.depositor));
    const transfer = {
      type: "transfer" as const,
      token: sandbox.deployment.usdg,
      to: v.address,
      amount: 1n,
    };
    await expect(vault.dryRun(transfer)).rejects.toBeInstanceOf(NotAgentError);
    await expect(vault.execute(transfer)).rejects.toBeInstanceOf(NotAgentError);
  });

  it("dry-runs read-only, as the vault's agent, but can't send", async () => {
    const vault = new BondedVault({ vault: v.address, publicClient: sandbox.publicClient });
    const transfer = {
      type: "transfer" as const,
      token: sandbox.deployment.usdg,
      to: ATTACKER,
      amount: usd(1),
    };
    expect((await vault.dryRun(transfer)).breach?.type).toBe("T1_UNAUTHORIZED_TRANSFER");
    await expect(vault.execute(transfer)).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(await breachCount(sandbox, v.address)).toBe(0n);
  });

  it("checks actions before touching the chain", async () => {
    const vault = client(v);
    await expect(
      vault.transfer({ token: "0x123" as `0x${string}`, to: ATTACKER, amount: 1n }),
    ).rejects.toThrow(/token must be an address/);
    await expect(vault.call({ target: v.address, data: "0x" })).rejects.toThrow(/itself/);
    const noRouter = new BondedVault({ vault: v.address, publicClient: sandbox.publicClient });
    await expect(
      noRouter.plan({ type: "swap", tokenIn: ATTACKER, tokenOut: ATTACKER, amountIn: 1n }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(() => new BondedVault({ vault: v.address })).toThrow(BondedError);
  });
});
