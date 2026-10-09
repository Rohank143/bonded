import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ANVIL_KEYS, CONTRACTS_DIR, Sandbox, judge } from "@bonded/arena";
import { Keeper, MODULE_DEFERRED_NOT_COVERED, connectChain } from "@bonded/keeper";
import {
  Quote,
  bondedRegistryAbi,
  coverManagerAbi,
  coverPoolAbi,
  erc7579AccountAbi,
  mandateModuleAbi,
  operatorBondAbi,
  prepareModuleInstall,
  quoteMessage,
  signQuote,
  testTokenAbi,
  type EvmMandateParams,
} from "@bondedhq/shared";
import { encodeAbiParameters, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { postgres } from "./postgres.js";

/**
 * The keeper with a smart account guarded by a MandateModule, on a local chain with the real
 * contracts and a real Postgres: it finds the module through the module factory, treats its
 * breaches like a vault's (a blocked one is ignored), and marks a Deferred breach on the module
 * ignored with the reason instead of retrying it forever. Only Enforce-mode modules can hold
 * cover, so the module here enforces.
 */

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const usd = (n: number) => BigInt(n) * 1_000_000n;

/** A contract compiled by `forge build` (contracts/evm/out). */
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS_DIR}out/${file}/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

let pg: Awaited<ReturnType<typeof postgres>>, sandbox: Sandbox;

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

/** The ERC-7579 reference account (MSAAdvanced behind a proxy), as the Forge tests deploy it. */
async function deployReferenceAccount(): Promise<Address> {
  const wallet = sandbox.wallet("deployer");
  const deploy = async (file: string, name: string, args: unknown[] = []) => {
    const { abi, bytecode } = artifact(file, name);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };
  const implementation = await deploy("MSAAdvanced.sol", "MSAAdvanced");
  const bootstrap = await deploy("Bootstrap.sol", "Bootstrap");
  const none: { module: Address; data: Hex }[] = [];
  const init = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [
      bootstrap,
      encodeFunctionData({
        abi: artifact("Bootstrap.sol", "Bootstrap").abi,
        functionName: "initMSA",
        args: [
          none,
          none,
          { module: "0x0000000000000000000000000000000000000000", data: "0x" },
          none,
        ],
      }),
    ],
  );
  return deploy("ModuleTestBase.sol", "TestMSAProxy", [
    implementation,
    encodeFunctionData({
      abi: artifact("MSAAdvanced.sol", "MSAAdvanced").abi,
      functionName: "initializeAccount",
      args: [init],
    }),
  ]);
}

it("tracks a module like a vault and ignores blocked and Deferred breaches on it", async () => {
  const d = sandbox.deployment;
  expect(d.moduleFactory).toBeDefined();
  const operator = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const agent = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.agent);
  const read = operator.read;

  // The operator registers the agent, stakes a bond and funds the pool.
  const { result: agentId } = await read.simulateContract({
    address: d.registry,
    abi: bondedRegistryAbi,
    functionName: "register",
    args: ["ipfs://bonded/test/module-agent.json"],
    account: operator.wallet.account,
  });
  await operator.send(d.registry, bondedRegistryAbi, "register", [
    "ipfs://bonded/test/module-agent.json",
  ]);
  await operator.send(d.usdg, testTokenAbi, "faucet", [usd(600_000)]);
  await operator.send(d.usdg, testTokenAbi, "approve", [d.bond, usd(10_000)]);
  await operator.send(d.bond, operatorBondAbi, "stake", [agentId, usd(10_000)]);
  await operator.send(d.usdg, testTokenAbi, "approve", [d.pool, usd(500_000)]);
  await operator.send(d.pool, coverPoolAbi, "deposit", [
    usd(500_000),
    operator.wallet.account.address,
  ]);

  // The account creates and installs its module in one batch (the shared helper), then is funded.
  const account = await deployReferenceAccount();
  // An allowed spender: approving it is fine, and its pulling later is a Deferred breach.
  const spender = sandbox.address("depositor");
  const params: EvmMandateParams = {
    mandateHash: `0x${"00".repeat(32)}`,
    mode: 1, // Enforce: the only mode a module can be insured in
    baseAsset: d.usdg,
    assets: [d.usdg, d.tsla],
    targets: [d.router, spender],
    selectors: [[], []],
    destinations: [],
    maxTxNotionalUsd6: usd(5_000),
    maxDailyNotionalUsd6: usd(25_000),
    maxDrawdownBps: 1500,
    maxSlippageBps: 300,
    freezeOnBreach: true,
  };
  const plan = await prepareModuleInstall(read, {
    moduleFactory: d.moduleFactory!,
    account,
    params,
    agent: agent.wallet.account.address,
    guardian: operator.wallet.account.address,
    agentId,
    accountType: "erc7579",
  });
  const entryPoint = await sandbox.impersonate(ENTRY_POINT);
  const batch = await entryPoint.writeContract({
    address: account,
    abi: erc7579AccountAbi,
    functionName: "execute",
    args: [plan.execute.mode, plan.execute.executionCalldata],
  });
  expect((await read.waitForTransactionReceipt({ hash: batch })).status).toBe("success");
  const module = plan.module;
  expect(
    await read.readContract({ address: module, abi: mandateModuleAbi, functionName: "installs" }),
  ).toBe(2n);
  await operator.send(d.usdg, testTokenAbi, "transfer", [account, usd(40_000)]);

  // Cover for the module, quoted against its on-chain mandate commitment.
  const now = Number((await read.getBlock()).timestamp);
  const signed = await signQuote(
    Quote.parse({
      agentId: agentId.toString(),
      vault: module,
      coverAmount: usd(20_000).toString(),
      premiumRateBps: 120,
      score: 90,
      modelFamily: "unknown",
      mandateHash: plan.params.mandateHash,
      reportHash: `0x${"ab".repeat(32)}`,
      minBond: "0",
      expiresAt: now + 3600,
      nonce: "1",
    }),
    { chainId: d.chainId, coverManager: d.coverManager, attesterKey: ANVIL_KEYS.deployer },
  );
  await operator.send(d.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(signed.quote),
    signed.signature,
  ]);

  // Breach 0: the agent tries to pay an attacker (blocked). Then it approves the allowed
  // spender, which pulls outside the module: breach 1, Deferred (recorded, never paid).
  const attacker: Address = "0x000000000000000000000000000000000000dEaD";
  const transfer = encodeFunctionData({
    abi: testTokenAbi,
    functionName: "transfer",
    args: [attacker, usd(1_000)],
  });
  await agent.send(module, mandateModuleAbi, "execute", [d.usdg, transfer]);
  await operator.send(module, mandateModuleAbi, "unfreeze", []);
  await agent.send(module, mandateModuleAbi, "execute", [
    d.usdg,
    encodeFunctionData({ abi: testTokenAbi, functionName: "approve", args: [spender, usd(500)] }),
  ]);
  const depositor = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.depositor);
  await depositor.send(d.usdg, testTokenAbi, "transferFrom", [account, spender, usd(500)]);
  await depositor.send(module, mandateModuleAbi, "reconcile", []);
  expect(
    (
      await read.readContract({
        address: module,
        abi: mandateModuleAbi,
        functionName: "getBreach",
        args: [1n],
      })
    ).breachType,
  ).toBe(3);

  const before = await read.readContract({
    address: d.usdg,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [account],
  });
  for (let i = 0; i < 5; i++) {
    await new Keeper(pg.db, operator, 0n).tick();
    const pending = await pg.db.pool.query("SELECT 1 FROM handled_events WHERE status='pending'");
    if (!pending.rowCount) break;
  }

  const tracked = await pg.db.pool.query("SELECT address FROM keeper_vaults");
  expect(tracked.rows.map((r) => r.address)).toContain(module.toLowerCase());
  const rows = (
    await pg.db.pool.query(
      "SELECT breach_id,status,error FROM handled_events WHERE vault=$1 ORDER BY breach_id",
      [module.toLowerCase()],
    )
  ).rows.map((r) => ({ id: Number(r.breach_id), status: r.status, error: r.error }));
  expect(rows).toEqual([
    { id: 0, status: "ignored", error: null }, // blocked: nothing was lost
    { id: 1, status: "ignored", error: MODULE_DEFERRED_NOT_COVERED },
  ]);

  // Nothing was paid; only premiums left the account.
  const after = await read.readContract({
    address: d.usdg,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [account],
  });
  expect(after).toBeLessThanOrEqual(before);
  expect((await pg.db.pool.query("SELECT 1 FROM events WHERE topic='claim.paid'")).rowCount).toBe(
    0,
  );

  // The Arena's judge reads a module's breach log exactly as it reads a vault's.
  const verdict = await judge(sandbox, module, null);
  expect(verdict.breaches.map((b) => [b.type, b.blocked])).toEqual([
    ["T1_UNAUTHORIZED_TRANSFER", true],
    ["T1_DEFERRED", false],
  ]);
  expect(verdict.totalLossUsd).toBe(500);
}, 240_000);
