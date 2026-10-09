import { afterAll, beforeAll, expect, it } from "vitest";
import { ANVIL_KEYS, Sandbox, createAgentVault, type AgentVault } from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import {
  bondedRegistryAbi,
  mandateHash,
  mandateVaultFactoryAbi,
  selfServeMessage,
  toEvmMandateParams,
  type EvmMandate,
  type SelfServeRequest,
} from "@bondedhq/shared";
import { parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let app: ReturnType<typeof createApi>;
let vault: AgentVault;
let other: AgentVault;
// createAgentVault registers the agent and creates its vault from the sandbox's operator key,
// so the operator is the owner and guardian who signs.
const owner = privateKeyToAccount(ANVIL_KEYS.operator);
const stranger = privateKeyToAccount(ANVIL_KEYS.depositor);
let clock = Date.now();
const now = () => Math.floor(clock / 1000);

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  vault = await createAgentVault(sandbox);
  other = await createAgentVault(sandbox);
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
    selfServe: {
      dailyRatings: 2,
      requests: { perClient: 1000, total: 1000, windowMs: 60_000 },
      now: () => clock,
    },
  });
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const sign = (request: SelfServeRequest, who = owner) =>
  who.signMessage({ message: selfServeMessage(request) });
const bodyOf = async (r: Response) => (await r.json()) as Record<string, string>;
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
/** Registers `v` for ratings; `overrides` change what is sent, and the owner signs exactly that. */
async function register(
  v: AgentVault,
  overrides: { vault?: `0x${string}`; mandate?: AgentVault["mandate"] } = {},
  who = owner,
) {
  const timestamp = now();
  const agentId = v.agentId.toString();
  const body = { vault: v.address, mandate: v.mandate, ...overrides };
  const signature = await sign(
    {
      action: "register",
      chainId: sandbox.deployment.chainId,
      agentId,
      vault: body.vault,
      kind: "partial",
      mandateHash: mandateHash(body.mandate),
      timestamp,
    },
    who,
  );
  return post("/self/agents", { agentId, kind: "partial", timestamp, signature, ...body });
}
async function rate(v: AgentVault, who = owner) {
  const timestamp = now();
  const agentId = v.agentId.toString();
  const signature = await sign(
    { action: "rate", chainId: sandbox.deployment.chainId, agentId, timestamp },
    who,
  );
  return post(`/self/agents/${agentId}/rate`, { timestamp, signature });
}

it("registers an agent only for its owner, with the vault's exact on-chain mandate", async () => {
  // Someone else's signature.
  expect((await register(vault, {}, stranger)).status).toBe(403);
  // A mandate that isn't the vault's, signed by the owner: the description is part of the hash.
  const edited = await register(vault, {
    mandate: { ...vault.mandate, description: "something else" },
  });
  expect(edited.status).toBe(400);
  expect((await bodyOf(edited)).error).toMatch(/doesn't match the vault's on-chain mandate/);
  // A vault that belongs to another agent (also the owner's).
  const wrong = await register(vault, { vault: other.address });
  expect(wrong.status).toBe(400);
  expect((await bodyOf(wrong)).error).toMatch(/belongs to another agent/);
  // The real thing.
  const ok = await register(vault);
  expect(ok.status).toBe(201);
  const status = await bodyOf(await app.request(`/self/agents/${vault.agentId}`));
  expect(status).toMatchObject({ registered: true, source: "user", kind: "partial" });
  expect(status.owner).toBe(owner.address.toLowerCase());
}, 120_000);

it("refuses an expired or forged rating request, then rates once an hour", async () => {
  // Signed 11 minutes ago.
  const old = now() - 11 * 60;
  const agentId = vault.agentId.toString();
  const stale = await sign({
    action: "rate",
    chainId: sandbox.deployment.chainId,
    agentId,
    timestamp: old,
  });
  expect(
    (await post(`/self/agents/${agentId}/rate`, { timestamp: old, signature: stale })).status,
  ).toBe(400);
  expect((await rate(vault, stranger)).status).toBe(403);
  const first = await rate(vault);
  expect(first.status).toBe(202);
  expect((await bodyOf(first)).runId).toMatch(/^[0-9a-f-]{36}$/);
  const again = await rate(vault);
  expect(again.status).toBe(429);
  expect((await bodyOf(again)).error).toMatch(/one rating an hour/);
  // An hour later it can be rated again.
  clock += 61 * 60_000;
  expect((await rate(vault)).status).toBe(202);
}, 120_000);

it("caps self-serve ratings per day across agents", async () => {
  expect((await register(other)).status).toBe(201);
  // Two ratings were used above (dailyRatings is 2 in this test).
  const res = await rate(other);
  expect(res.status).toBe(429);
  expect((await bodyOf(res)).error).toMatch(/today's self-serve ratings/);
}, 120_000);

it("an unregistered agent can't be rated, and the operator's agents can't be taken over", async () => {
  const third = await createAgentVault(sandbox);
  expect((await rate(third)).status).toBe(404);
  await pg.db.reconcileAgents(sandbox.deployment.chainId, [
    { agentId: third.agentId.toString(), config: { kind: "hardened" } },
  ]);
  expect((await register(third)).status).toBe(409);
  // Reconciling the operator's file never disables a user's agent.
  const status = await bodyOf(await app.request(`/self/agents/${vault.agentId}`));
  expect(status).toMatchObject({ registered: true, source: "user" });
}, 120_000);

it("quotes need no operator token, but cover is capped without it", async () => {
  const res = await post("/quotes", {
    agentId: vault.agentId.toString(),
    vault: vault.address,
    coverAmount: (20_001n * 1_000_000n).toString(),
  });
  expect(res.status).toBe(400);
  expect((await bodyOf(res)).error).toMatch(/capped at 20,000/);
  // Within the cap it reaches the pricing, which refuses an agent with no score yet.
  const within = await post("/quotes", {
    agentId: vault.agentId.toString(),
    vault: vault.address,
    coverAmount: (1_000n * 1_000_000n).toString(),
  });
  expect(within.status).not.toBe(401);
}, 120_000);

/**
 * A vault whose creation carried the hash of one mandate but enforces another: the factory
 * accepts both from the caller, so only the creation call shows what the vault really enforces.
 */
async function vaultWithMismatch(change: (m: EvmMandate) => EvmMandate) {
  const op = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const d = sandbox.deployment;
  const reg = await op.read.waitForTransactionReceipt({
    hash: await op.send(d.registry, bondedRegistryAbi, "register", ["ipfs://x"]),
  });
  const agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: reg.logs,
    eventName: "Registered",
  })[0]!.args.agentId;
  const enforced = { ...vault.mandate, agentId: agentId.toString() };
  const claimed = change(enforced);
  // What the vault enforces: `enforced`; what its hash says: `claimed`.
  const params = { ...toEvmMandateParams(enforced), mandateHash: mandateHash(claimed) };
  const made = await op.read.waitForTransactionReceipt({
    hash: await op.send(d.factory, mandateVaultFactoryAbi, "createVault", [
      params,
      op.wallet.account.address,
      op.wallet.account.address,
      agentId,
      "m",
      "M",
    ]),
  });
  const address = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: made.logs,
    eventName: "VaultCreated",
  })[0]!.args.vault;
  return { v: { address, agentId, mandate: enforced }, claimed };
}

it("refuses a vault whose real rules differ from the mandate its hash names", async () => {
  for (const [label, change] of [
    ["mode", (m: EvmMandate) => ({ ...m, mode: "enforce" as const })],
    [
      "maxTxNotionalUsd6",
      (m: EvmMandate) => ({ ...m, limits: { ...m.limits, maxTxNotionalUsd: 1 } }),
    ],
    ["destinations", (m: EvmMandate) => ({ ...m, destinations: [owner.address] })],
  ] as const) {
    const { v, claimed } = await vaultWithMismatch(change);
    const res = await register(v, { mandate: claimed });
    expect(res.status, label).toBe(400);
    expect((await bodyOf(res)).error, label).toMatch(
      new RegExp(`enforces different rules from this mandate \\(.*${label}`),
    );
  }
}, 120_000);

it("parallel rating requests queue at most one, for one agent and across agents", async () => {
  const fourth = await createAgentVault(sandbox);
  const fifth = await createAgentVault(sandbox);
  const sixth = await createAgentVault(sandbox);
  for (const v of [fourth, fifth, sixth]) expect((await register(v)).status).toBe(201);
  // A fresh day for this app instance, with room for exactly two more ratings.
  clock += 25 * 3_600_000;
  const parallelApp = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
    selfServe: {
      dailyRatings: 2,
      requests: { perClient: 1000, total: 1000, windowMs: 60_000 },
      now: () => clock,
    },
  });
  const rateOn = async (v: AgentVault) => {
    const timestamp = now();
    const agentId = v.agentId.toString();
    const signature = await sign({
      action: "rate",
      chainId: sandbox.deployment.chainId,
      agentId,
      timestamp,
    });
    return (
      await parallelApp.request(`/self/agents/${agentId}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp, signature }),
      })
    ).status;
  };
  // The same agent, four times at once: one is queued.
  const same = await Promise.all([1, 2, 3, 4].map(() => rateOn(fourth)));
  expect(same.filter((s) => s === 202)).toHaveLength(1);
  // One daily slot left, two agents at once: one is queued.
  const across = await Promise.all([fifth, sixth].map(rateOn));
  expect(across.filter((s) => s === 202)).toHaveLength(1);
  expect(across.filter((s) => s === 429)).toHaveLength(1);
}, 120_000);
