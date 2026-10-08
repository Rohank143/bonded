import { ViemWalletProvider } from "@coinbase/agentkit";
import { ANVIL_KEYS } from "@bonded/sandbox";
import { createWalletClient, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BondedWalletProvider } from "../src/agentkit.js";
import { BondedVault, CallRevertedError, guarded, VaultFrozenError } from "../src/index.js";
import { type AccountKind, protectedAccount, type ProtectedAccount } from "./accounts.js";
import { ATTACKER, Sandbox, balanceOf, breachCount } from "./chain.js";
import { fakeSentinelApi } from "./sentinel-api.js";

let sandbox: Sandbox;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // AgentKit posts analytics to Coinbase from every wallet provider; keep tests local.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host === "cca-lite.coinbase.com") return new Response(null, { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  sandbox = await Sandbox.start();
}, 180_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await sandbox?.stop();
});

const usd = (n: number) => parseUnits(String(n), 6);
const agentKey = () => privateKeyToAccount(ANVIL_KEYS.agent);
const client = (p: ProtectedAccount) =>
  new BondedVault({
    vault: p.module,
    publicClient: sandbox.publicClient,
    account: agentKey(),
    router: sandbox.deployment.router,
  });

describe.each<AccountKind>(["msa", "safe"])("a MandateModule on a %s account", (kind) => {
  let p: ProtectedAccount;
  let vault: BondedVault;
  beforeAll(async () => {
    p = await protectedAccount(sandbox, kind);
    vault = client(p);
  });

  it("is recognised as a module, with its account holding the funds", async () => {
    expect(await vault.status()).toMatchObject({
      kind: "module",
      holder: p.account,
      mode: "monitor",
      frozen: false,
      breachCount: 0n,
      agent: sandbox.address("agent"),
      // A module's mandate hash is the commitment to its params, which the factory checked.
      mandateHash: p.mandateHash,
    });
    expect(p.mandateHash).toBe(p.params.mandateHash);
  });

  it("swaps within the mandate from the account: the account approves and receives", async () => {
    const d = sandbox.deployment;
    const swap = { tokenIn: d.usdg, tokenOut: d.tsla, amountIn: usd(1_000) };
    expect((await vault.dryRun({ type: "swap", ...swap })).ok).toBe(true);
    const result = await vault.swap(swap);
    expect(result).toMatchObject({ breaches: [] });
    expect(result.hashes).toHaveLength(2);
    expect(await balanceOf(sandbox, d.usdg, p.account)).toBe(usd(49_000));
    expect(await balanceOf(sandbox, d.tsla, p.account)).toBeGreaterThan(0n);
  });

  it("surfaces the account's failed call as CallRevertedError, recording nothing", async () => {
    const d = sandbox.deployment;
    const tooMuch = { type: "transfer" as const, token: d.tsla, to: p.account, amount: 10n ** 40n };
    const error = await vault.execute(tooMuch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallRevertedError);
    // Safe7579 drops the token's reason and reverts with ExecutionFailed().
    if (kind === "safe") expect((error as Error).message).toMatch(/ExecutionFailed/);
    expect(await breachCount(sandbox, p.module)).toBe(0n);
  });

  it("predicts a breach, then records exactly that breach and freezes (Monitor)", async () => {
    const d = sandbox.deployment;
    const transfer = { token: d.usdg, to: ATTACKER, amount: usd(300) };
    const prediction = await vault.dryRun({ type: "transfer", ...transfer });
    expect(prediction).toMatchObject({
      ok: false,
      wouldFreeze: true,
      breach: { type: "T1_UNAUTHORIZED_TRANSFER", blocked: false, lossUsd6: usd(300) },
    });
    const result = await vault.transfer(transfer);
    expect(result.breaches).toEqual([prediction.breach]);
    expect(await vault.breaches()).toEqual([prediction.breach]);
    await expect(vault.dryRun({ type: "transfer", ...transfer })).rejects.toBeInstanceOf(
      VaultFrozenError,
    );
  });
});

describe("a guarded MandateModule with Sentinel", () => {
  it("asks Sentinel about the module, signed by the agent key, then trades", async () => {
    const p = await protectedAccount(sandbox, "msa");
    const sentinel = fakeSentinelApi({
      chainId: sandbox.chain.id,
      agent: sandbox.address("agent"),
      agentId: p.agentId,
      vault: p.module,
    });
    const safe = guarded(client(p), {
      sentinel: { apiUrl: "http://api.test", mandate: p.mandate, fetch: sentinel.fetch },
    });
    const d = sandbox.deployment;
    const result = await safe.swap({ tokenIn: d.usdg, tokenOut: d.tsla, amountIn: usd(200) });
    expect(result.sentinel).toMatchObject({ blocked: false, model: "fake-sentinel" });
    expect(sentinel.asked).toHaveLength(1);
    expect(result.breaches).toEqual([]);
    expect(await balanceOf(sandbox, d.tsla, p.account)).toBeGreaterThan(0n);
  });
});

describe("MandateModule edge cases", () => {
  it("says when the module isn't installed on its account", async () => {
    const p = await protectedAccount(sandbox, "msa", {}, { install: false });
    const vault = client(p);
    const action = {
      type: "transfer" as const,
      token: sandbox.deployment.usdg,
      to: p.account,
      amount: 1n,
    };
    await expect(vault.dryRun(action)).rejects.toMatchObject({ code: "MODULE_NOT_INSTALLED" });
    await expect(vault.execute(action)).rejects.toMatchObject({ code: "MODULE_NOT_INSTALLED" });
  });

  it("gives AgentKit the account as the wallet, and acts through the module", async () => {
    const p = await protectedAccount(sandbox, "safe");
    const provider = await BondedWalletProvider.create({
      wallet: new ViemWalletProvider(
        createWalletClient({
          account: agentKey(),
          chain: sandbox.chain,
          transport: http(sandbox.rpcUrl),
        }) as never,
        { rpcUrl: sandbox.rpcUrl },
      ),
      vault: p.module,
    });
    expect(provider.getAddress()).toBe(p.account);
    const hash = await provider.sendTransaction({
      to: sandbox.deployment.usdg,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [ATTACKER, usd(5)],
      }),
    });
    await provider.waitForTransactionReceipt(hash);
    expect(await balanceOf(sandbox, sandbox.deployment.usdg, ATTACKER)).toBeGreaterThanOrEqual(
      usd(5),
    );
    expect(await breachCount(sandbox, p.module)).toBe(1n);
  });
});
