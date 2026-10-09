import { afterEach, describe, expect, it } from "vitest";
import {
  FRAMEWORKS,
  SERVICE_KINDS,
  connectionFor,
  hostingFor,
  initCommand,
  initWorks,
  rememberFramework,
  rememberedFramework,
  snippetIdFor,
  serviceCommand,
  vaultChange,
  vaultEnv,
} from "./frameworks";
import { snippets } from "./snippets";

afterEach(() => localStorage.clear());

describe("framework-first answers", () => {
  it("maps where it runs to the connection, both ways", () => {
    expect(connectionFor("machine")).toBe("runner");
    expect(connectionFor("online")).toBe("url");
    expect(hostingFor("runner")).toBe("machine");
    expect(hostingFor("url")).toBe("online");
  });

  it("opens a snippet tab that exists for every framework and connection", () => {
    for (const connection of ["runner", "url"] as const) {
      const ids = snippets(connection, "tools").map((s) => s.id);
      for (const f of FRAMEWORKS) expect(ids).toContain(snippetIdFor(f, connection));
    }
  });

  it("builds init exactly as the runner takes it", () => {
    expect(initCommand({ connection: "url" })).toBe("npx @bondedhq/runner init --url");
    expect(initCommand({ connection: "runner" })).toBe("npx @bondedhq/runner init");
    expect(
      initCommand({ connection: "runner", token: "bonded_rt_x", gatewayUrl: "https://gw.example" }),
    ).toBe("npx @bondedhq/runner init --token bonded_rt_x --gateway https://gw.example");
    expect(initWorks("python")).toBe(false);
    expect(initWorks("eliza")).toBe(true);
  });

  it("shows the one line init adds for each framework", () => {
    expect(vaultChange("agentkit").code).toBe(
      "const agentKit = await bondedAgentKit({ walletProvider, actionProviders });",
    );
    expect(vaultChange("eliza").code).toBe("plugins: [...bondedPlugins, ...yourPlugins],");
    expect(vaultChange("langchain").code).toBe("const tools = await bondedTools(productionTools);");
    expect(vaultChange("ai-sdk").code).toBe("const tools = await bondedTools(productionTools);");
    expect(vaultChange("mcp").code).toContain("bondedMcpUrl(yourServerUrl)");
    expect(vaultChange("mcp").code).toContain("await bondedVault.swap(");
    expect(vaultChange("langchain").importLine).toBe('import { bondedTools } from "./bonded";');
    expect(vaultChange("python").importLine).toBeUndefined();
  });

  it("lists the vault's environment, with the vault filled in", () => {
    const env = vaultEnv({ vault: "0xAA", chainId: 46630, rpcUrl: "https://rpc.example" });
    expect(env.split("\n").map((l) => l.split("=")[0])).toEqual([
      "BONDED_VAULT_ADDRESS",
      "BONDED_AGENT_KEY",
      "BONDED_ROUTER_ADDRESS",
      "BONDED_VAULT_CHAIN_ID",
      "BONDED_VAULT_RPC_URL",
    ]);
    expect(env).toContain("BONDED_VAULT_ADDRESS=0xAA");
    expect(env).toContain("BONDED_VAULT_CHAIN_ID=46630");
  });

  it("prints a service file for each way of keeping the runner up", () => {
    expect(SERVICE_KINDS.map((k) => serviceCommand(k.id, "https://gw.example"))).toEqual([
      "npx @bondedhq/runner service --print systemd --gateway https://gw.example -- <your agent command>",
      "npx @bondedhq/runner service --print pm2 --gateway https://gw.example -- <your agent command>",
      "npx @bondedhq/runner service --print docker --gateway https://gw.example -- <your agent command>",
    ]);
    expect(SERVICE_KINDS.find((k) => k.id === "docker")!.note).toMatch(/unless-stopped/);
  });

  it("remembers the framework in this browser, and ignores anything else stored", () => {
    expect(rememberedFramework()).toBeUndefined();
    rememberFramework("langchain");
    expect(rememberedFramework()).toBe("langchain");
    localStorage.setItem("bonded:framework", "cobol");
    expect(rememberedFramework()).toBeUndefined();
  });
});
