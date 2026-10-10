import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEvmDeployment } from "@bondedhq/shared";
import { agentConfig } from "../src/worker.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const deployment = parseEvmDeployment(read("contracts/evm/deployments/46630.json"), 46630);
const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));

/** One operator agent entry, on the current deployment. */
const base = {
  kind: "hardened",
  mandate: {
    version: 1,
    agentId: "1",
    mode: "monitor",
    limits: {
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "A test entry.",
    chain: { family: "evm", chainId: 46630 },
    baseAsset: deployment.usdg,
    assets: [deployment.usdg, deployment.tsla],
    targets: [{ address: deployment.router, selectors: ["0x6e81221c"] }],
    destinations: [],
  },
  codeHash: `0x${"cd".repeat(32)}`,
};

it("the deployed agents file loads the way the service loads it", () => {
  for (const config of configs) {
    expect(config.mandate.chain.chainId).toBe(deployment.chainId);
    expect(config.mandate.baseAsset.toLowerCase()).toBe(deployment.usdg.toLowerCase());
    for (const asset of config.mandate.assets)
      expect(
        [deployment.usdg, deployment.tsla, deployment.amzn, deployment.nvda].map((a) =>
          a.toLowerCase(),
        ),
      ).toContain(asset.toLowerCase());
  }
  expect(new Set(configs.map((c) => c.mandate.agentId)).size).toBe(configs.length);
});

it("an agent's TEE entry needs an https URL and a compose hash, and nothing else", () => {
  const tee = { url: "https://app-8080.dstack.example", composeHash: `0x${"ab".repeat(32)}` };
  expect(agentConfig.parse({ ...base, tee }).tee).toEqual(tee);
  expect(agentConfig.parse(base).tee).toBeUndefined();
  for (const bad of [
    { ...tee, url: "http://app-8080.dstack.example" },
    { ...tee, composeHash: "0x12" },
    { url: tee.url },
    { ...tee, extra: true },
  ])
    expect(() => agentConfig.parse({ ...base, tee: bad })).toThrow();
});

it("repeats is optional, a whole number from 1 to 10", () => {
  expect(agentConfig.parse(base).repeats).toBeUndefined();
  for (const repeats of [1, 5, 10])
    expect(agentConfig.parse({ ...base, repeats }).repeats).toBe(repeats);
  for (const bad of [0, 11, 1.5, -1, "5", null])
    expect(() => agentConfig.parse({ ...base, repeats: bad })).toThrow();
});

// The demo agents (the Gate 1 hardened agent, the TEE agent and the demo's partial Agent A) were
// registered on the deployment of Sep 27, 2026. After the redeployment of Oct 10 the file is empty
// until they are seeded again on the new contracts (docs/DEVELOPING.md, "After a redeployment");
// these checks come back, with the new agent ids, when they are.
describe.skipIf(configs.length === 0)("the demo agents", () => {
  it("there is one TEE agent, in Enforce mode, with a dstack URL and a compose hash", () => {
    const tee = configs.filter((c) => c.tee);
    expect(tee).toHaveLength(1);
    expect(tee[0]?.mandate.mode).toBe("enforce");
    expect(tee[0]?.tee?.url).toMatch(/^https:\/\/[0-9a-f]{40}-8080\./);
    expect(tee[0]?.tee?.composeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the demo's Agent A is the one partial agent: Monitor mode, refunds to the depositor only", () => {
    const a = configs.filter((c) => c.kind === "partial");
    expect(a).toHaveLength(1);
    expect(a[0]?.mandate.mode).toBe("monitor");
    expect(a[0]?.mandate.freezeOnBreach).toBe(true);
    // The one destination is what its weak address check trusts, and what address poisoning imitates.
    expect(a[0]?.mandate.destinations).toHaveLength(1);
    expect(a[0]?.repeats).toBe(5);
  });
});
