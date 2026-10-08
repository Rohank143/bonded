import { type Action, AgentKit, erc20ActionProvider, ViemWalletProvider } from "@coinbase/agentkit";
import { ANVIL_KEYS } from "@bonded/sandbox";
import {
  type Chain,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BondedWalletProvider } from "../src/agentkit.js";
import { BondedVault } from "../src/index.js";
import {
  ATTACKER,
  Sandbox,
  balanceOf,
  breachCount,
  createTestVault,
  type TestVault,
  withMulticall3,
} from "./chain.js";
import { fakeSentinelApi } from "./sentinel-api.js";

let sandbox: Sandbox;
let chain: Chain;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // AgentKit posts analytics to Coinbase from every wallet provider and action; keep tests local.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host === "cca-lite.coinbase.com") return new Response(null, { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
  sandbox = await Sandbox.start();
  chain = await withMulticall3(sandbox);
}, 180_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await sandbox?.stop();
});

const usd = (n: number) => parseUnits(String(n), 6);

/** AgentKit with its stock ERC-20 actions, wallet = the vault, sending with the agent key. */
async function agentKit(v: TestVault, guard = false) {
  const agentWallet = new ViemWalletProvider(
    createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.agent),
      chain,
      transport: http(sandbox.rpcUrl),
    }) as never,
    { rpcUrl: sandbox.rpcUrl },
  );
  const provider = new BondedWalletProvider({ wallet: agentWallet, vault: v.address, guard });
  const kit = await AgentKit.from({
    walletProvider: provider,
    actionProviders: [erc20ActionProvider()],
  });
  const action = (name: string) => {
    const found = kit.getActions().find((a: Action) => a.name === `ERC20ActionProvider_${name}`);
    if (!found) throw new Error(`no AgentKit action ${name}`);
    return (args: Record<string, unknown>) => found.invoke(args);
  };
  return { provider, action };
}

describe("AgentKit's ERC-20 actions through a Monitor-mode vault", () => {
  let v: TestVault;
  let kit: Awaited<ReturnType<typeof agentKit>>;
  beforeAll(async () => {
    v = await createTestVault(sandbox, { destinations: [sandbox.address("depositor")] });
    kit = await agentKit(v);
  });

  it("sees the vault as its wallet", async () => {
    expect(kit.provider.getAddress()).toBe(v.address);
    const text = await kit.action("get_balance")({ tokenAddress: sandbox.deployment.usdg });
    expect(text).toContain(`at address ${v.address} is 50000`);
  });

  it("an allowed transfer runs through the vault with nothing recorded", async () => {
    const depositor = sandbox.address("depositor");
    const before = await balanceOf(sandbox, sandbox.deployment.usdg, depositor);
    const text = await kit.action("transfer")({
      amount: "100",
      tokenAddress: sandbox.deployment.usdg,
      destinationAddress: depositor,
    });
    expect(text).toMatch(/^Transferred 100 /);
    expect(await balanceOf(sandbox, sandbox.deployment.usdg, depositor)).toBe(before + usd(100));
    expect(await breachCount(sandbox, v.address)).toBe(0n);
  });

  it("a transfer to an outside address is recorded in the vault's breach log", async () => {
    const text = await kit.action("transfer")({
      amount: "250",
      tokenAddress: sandbox.deployment.usdg,
      destinationAddress: ATTACKER,
    });
    // Monitor mode: it goes through, and the vault records it and freezes the agent.
    expect(text).toMatch(/^Transferred 250 /);
    const vault = new BondedVault({ vault: v.address, publicClient: sandbox.publicClient });
    expect(await vault.breaches()).toMatchObject([
      { id: 0n, type: "T1_UNAUTHORIZED_TRANSFER", blocked: false, lossUsd6: usd(250) },
    ]);
    expect((await vault.status()).frozen).toBe(true);
    // Frozen: the next action fails with the vault's reason.
    const next = await kit.action("transfer")({
      amount: "1",
      tokenAddress: sandbox.deployment.usdg,
      destinationAddress: sandbox.address("depositor"),
    });
    expect(next).toMatch(/Error transferring the asset: VaultFrozenError/);
  });
});

describe("AgentKit through an Enforce-mode vault", () => {
  it("reports a blocked approval as a failure, and the vault records the attempt", async () => {
    const v = await createTestVault(sandbox, { mode: "enforce" });
    const kit = await agentKit(v);
    const text = await kit.action("approve")({
      amount: "1000",
      tokenAddress: sandbox.deployment.usdg,
      spenderAddress: ATTACKER,
    });
    expect(text).toMatch(/Error approving tokens: BlockedByMandateError/);
    const vault = new BondedVault({ vault: v.address, publicClient: sandbox.publicClient });
    expect(await vault.breaches()).toMatchObject([
      { type: "T1_UNAUTHORIZED_APPROVAL", blocked: true },
    ]);
  });
});

describe("the AgentKit wallet's limits", () => {
  it("refuses native value, contract creation and raw signatures", async () => {
    const v = await createTestVault(sandbox);
    const { provider } = await agentKit(v);
    await expect(provider.sendTransaction({ to: ATTACKER, value: 1n })).rejects.toMatchObject({
      code: "NATIVE_VALUE",
    });
    await expect(provider.nativeTransfer()).rejects.toMatchObject({ code: "NATIVE_VALUE" });
    await expect(provider.sendTransaction({ data: "0x00" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(provider.signTypedData()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(provider.signTransaction()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("with a guard, refuses a breaching transaction before sending it", async () => {
    const v = await createTestVault(sandbox);
    const { provider, action } = await agentKit(v, true);
    const text = await action("transfer")({
      amount: "10",
      tokenAddress: sandbox.deployment.usdg,
      destinationAddress: ATTACKER,
    });
    expect(text).toMatch(/PredictedBreachError: refused: the vault would record a breach/);
    expect(await breachCount(sandbox, v.address)).toBe(0n);
    // An allowed call still goes through the guard.
    const hash = await provider.sendTransaction({
      to: sandbox.deployment.usdg,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [v.address, 1n],
      }),
    });
    expect((await provider.waitForTransactionReceipt(hash)).status).toBe("success");
  });
});

describe("AgentKit with Sentinel in the guard", () => {
  it("signs the check with the AgentKit wallet, gets Sentinel's answer, then trades", async () => {
    const v = await createTestVault(sandbox, { destinations: [sandbox.address("depositor")] });
    const wallet = new ViemWalletProvider(
      createWalletClient({
        account: privateKeyToAccount(ANVIL_KEYS.agent),
        chain,
        transport: http(sandbox.rpcUrl),
      }) as never,
      { rpcUrl: sandbox.rpcUrl },
    );
    const signed: unknown[] = [];
    const signMessage = wallet.signMessage.bind(wallet);
    wallet.signMessage = (message) => {
      signed.push(message);
      return signMessage(message);
    };
    const sentinel = fakeSentinelApi({
      chainId: chain.id,
      agent: sandbox.address("agent"),
      agentId: v.agentId,
      vault: v.address,
    });
    const provider = new BondedWalletProvider({
      wallet,
      vault: v.address,
      guard: { sentinel: { apiUrl: "http://api.test", mandate: v.mandate, fetch: sentinel.fetch } },
    });
    const kit = await AgentKit.from({
      walletProvider: provider,
      actionProviders: [erc20ActionProvider()],
    });
    const transfer = kit
      .getActions()
      .find((a: Action) => a.name === "ERC20ActionProvider_transfer")!;
    const depositor = sandbox.address("depositor");
    const before = await balanceOf(sandbox, sandbox.deployment.usdg, depositor);
    const text = await transfer.invoke({
      amount: "40",
      tokenAddress: sandbox.deployment.usdg,
      destinationAddress: depositor,
    });
    expect(text).toMatch(/^Transferred 40 /);
    expect(signed).toHaveLength(1); // the Sentinel check, signed by the wallet
    expect(sentinel.asked).toEqual([
      { tool: "call", args: expect.objectContaining({ target: sandbox.deployment.usdg }) },
    ]);
    expect(await balanceOf(sandbox, sandbox.deployment.usdg, depositor)).toBe(before + usd(40));
  });
});
