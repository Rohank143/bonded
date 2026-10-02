import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { mandateHash, parseEvmDeployment } from "@bonded/shared";
import { agentConfig } from "../src/worker.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

it("the deployed agents file loads the way the service loads it", () => {
  const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));
  const deployment = parseEvmDeployment(read("contracts/evm/deployments/46630.json"), 46630);
  expect(configs.length).toBeGreaterThan(0);
  for (const config of configs) {
    expect(config.mandate.chain.chainId).toBe(deployment.chainId);
    expect(config.mandate.baseAsset.toLowerCase()).toBe(deployment.usdg.toLowerCase());
  }
  expect(new Set(configs.map((c) => c.mandate.agentId)).size).toBe(configs.length);
});

it("agent 2 matches the mandate attested on chain during Gate 1", () => {
  const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));
  const evidence = JSON.parse(read("docs/progress/evidence/gate-1-testnet.json"));
  const agent = configs.find((c) => c.mandate.agentId === "2");
  expect(agent && mandateHash(agent.mandate)).toBe(evidence.attestation.attestation.mandateHash);
});

it("an agent's TEE entry needs an https URL and a compose hash, and nothing else", () => {
  const base = JSON.parse(read("config/agents.46630.json"))[0];
  delete base.tee;
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

it("the deployed TEE demo agent is agent 3, with a TEE entry, and agent 2 has none", () => {
  const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));
  const tee = configs.find((c) => c.tee);
  // Agent 2 stays the Gate 1 breach demo, without a TEE: binding it would break its live flow.
  expect(configs.find((c) => c.mandate.agentId === "2")?.tee).toBeUndefined();
  expect(tee?.mandate.agentId).toBe("3");
  expect(tee?.mandate.mode).toBe("enforce");
  expect(tee?.tee?.url).toMatch(/^https:\/\/[0-9a-f]{40}-8080\./);
  expect(tee?.tee?.composeHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(configs.filter((c) => c.tee)).toHaveLength(1);
});

it("repeats is optional, a whole number from 1 to 10, and is set only for the TEE demo agent", () => {
  const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));
  const base = JSON.parse(read("config/agents.46630.json"))[0];
  expect(agentConfig.parse(base).repeats).toBeUndefined();
  for (const repeats of [1, 5, 10])
    expect(agentConfig.parse({ ...base, repeats }).repeats).toBe(repeats);
  for (const bad of [0, 11, 1.5, -1, "5", null])
    expect(() => agentConfig.parse({ ...base, repeats: bad })).toThrow();
  // Agent 2 stays at one run per seed: it is the Gate 1 breach demo and its evidence is pinned.
  expect(configs.find((c) => c.mandate.agentId === "2")?.repeats).toBeUndefined();
  expect(configs.find((c) => c.mandate.agentId === "3")?.repeats).toBe(5);
});
