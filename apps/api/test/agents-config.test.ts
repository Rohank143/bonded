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
