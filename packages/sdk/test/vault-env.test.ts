import { describe, expect, it } from "vitest";
import { BondedError, bondedVaultFromEnv } from "../src/index.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

describe("bondedVaultFromEnv", () => {
  it("is undefined until BONDED_VAULT_ADDRESS is set, so the same code runs without a vault", () => {
    expect(bondedVaultFromEnv({})).toBeUndefined();
  });

  it("builds a vault on Robinhood Chain testnet by default", async () => {
    const vault = bondedVaultFromEnv({ BONDED_VAULT_ADDRESS: VAULT, BONDED_AGENT_KEY: KEY })!;
    expect(vault.address).toBe(VAULT);
    expect(vault.walletClient?.chain?.id).toBe(46630);
    expect(vault.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("names every missing or malformed variable", () => {
    const error = (() => {
      try {
        bondedVaultFromEnv({
          BONDED_VAULT_ADDRESS: VAULT,
          BONDED_VAULT_CHAIN_ID: "999999",
          BONDED_ROUTER_ADDRESS: "nope",
        });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BondedError);
    expect((error as BondedError).message).toBe(
      "BONDED_AGENT_KEY (the vault's agent key) isn't set; BONDED_VAULT_RPC_URL isn't set (no default RPC for chain 999999); BONDED_ROUTER_ADDRESS isn't an address",
    );
  });

  it("never reads the runner's episode variables", () => {
    expect(
      bondedVaultFromEnv({
        BONDED_VAULT: VAULT,
        BONDED_SESSION_KEY: KEY,
        BONDED_RPC_URL: "http://x",
      }),
    ).toBeUndefined();
  });
});
