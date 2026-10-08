import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evmChainById, evmDeploymentSchema, parseEvmDeployment } from "../src/index.js";

// Output of `pnpm demo:local` (anvil's deterministic addresses), keys in the order forge writes them.
const LOCAL = {
  amzn: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
  bond: "0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE",
  bountyBoard: "0x68B1D87F95878fE05B998F19b66F4baba5De1aed",
  chainId: 31337,
  claimsEngine: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d",
  coverManager: "0x3Aa5ebB10DC797CAC828524e59A333d0A371443c",
  deployedAtBlock: 0,
  disputeModule: "0x59b670e9fA9D0A427751Af201D676719a970857b",
  factory: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
  nvda: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  oracle: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  pool: "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1",
  registry: "0x9A676e781A523b5d0C0e43731313A708CB607508",
  router: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  tsla: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  usdg: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

describe("EVM deployment files", () => {
  it("parses a Deploy.s.sol output and checksums addresses", () => {
    const deployment = parseEvmDeployment(JSON.stringify(LOCAL), 31337);
    expect(deployment.coverManager).toBe(LOCAL.coverManager);
    expect(deployment.amzn).toBe("0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0");
  });

  it("rejects a file for another chain", () => {
    expect(() => parseEvmDeployment(JSON.stringify(LOCAL), 46630)).toThrow(/chain 31337/);
  });

  it("rejects missing and unknown keys", () => {
    const missing: Partial<typeof LOCAL> = { ...LOCAL };
    delete missing.registry;
    expect(evmDeploymentSchema.safeParse(missing).success).toBe(false);
    expect(evmDeploymentSchema.safeParse({ ...LOCAL, extra: LOCAL.usdg }).success).toBe(false);
  });

  it("accepts the module factory, which older deployments don't have", () => {
    const moduleFactory = "0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB"; // `pnpm demo:local` again
    expect(parseEvmDeployment(JSON.stringify({ ...LOCAL, moduleFactory })).moduleFactory).toBe(
      moduleFactory,
    );
    expect(parseEvmDeployment(JSON.stringify(LOCAL)).moduleFactory).toBeUndefined();
  });

  it("rejects invalid addresses", () => {
    expect(evmDeploymentSchema.safeParse({ ...LOCAL, pool: "0x1234" }).success).toBe(false);
  });
});

describe("committed deployment files", () => {
  const dir = fileURLToPath(new URL("../../../contracts/evm/deployments/", import.meta.url));
  const files = readdirSync(dir).filter(
    (name) => /^\d+\.json$/.test(name) && name !== "31337.json",
  );

  it("includes Robinhood Chain testnet, Arbitrum Sepolia and Ethereum Sepolia", () => {
    expect(files).toEqual(expect.arrayContaining(["46630.json", "421614.json", "11155111.json"]));
  });

  it.each(files)("%s parses and matches its chain id", (name) => {
    const chainId = Number(name.replace(".json", ""));
    const deployment = parseEvmDeployment(readFileSync(join(dir, name), "utf8"), chainId);
    expect(evmChainById(chainId)).toBeDefined();
    expect(deployment.deployedAtBlock).toBeGreaterThan(0);
  });
});
