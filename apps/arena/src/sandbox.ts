import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type EvmDeployment, parseEvmDeployment } from "@bonded/shared";
import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const run = promisify(execFile);

/** contracts/evm, resolved from src/ or dist/ alike. */
export const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/evm/", import.meta.url));

/**
 * anvil's well-known development keys (public test keys, never used on a real network).
 * anvil funds these with test ETH on fresh chains and on forks alike.
 */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  depositor: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
export type SandboxRole = keyof typeof ANVIL_KEYS;

export interface SandboxOptions {
  /**
   * RPC of a live chain to fork (e.g. Robinhood Chain testnet). The sandbox then attaches to
   * the committed deployment for that chain. Without it, a fresh local chain is started and
   * the protocol is deployed to it.
   */
  forkUrl?: string;
  /** Port for anvil; a free one is picked by default. */
  port?: number;
  /** Progress messages (deploy output, etc.). */
  log?: (message: string) => void;
}

type ArenaWallet = WalletClient<Transport, Chain, Account>;

/**
 * An isolated chain for Arena episodes: a local anvil node, either fresh (with the protocol
 * deployed by the same scripts as production) or forking a live testnet. Nothing here can
 * touch a real network: anvil keeps every transaction local.
 */
export class Sandbox {
  private constructor(
    private readonly anvil: ChildProcess,
    readonly rpcUrl: string,
    readonly chain: Chain,
    readonly deployment: EvmDeployment,
    readonly forked: boolean,
    readonly publicClient: PublicClient<Transport, Chain>,
  ) {}

  static async start(options: SandboxOptions = {}): Promise<Sandbox> {
    const log = options.log ?? (() => {});
    const port = options.port ?? (await freePort());
    const rpcUrl = `http://127.0.0.1:${port}`;

    const args = ["--port", String(port), "--silent"];
    if (options.forkUrl) {
      // Fork a few blocks behind the tip: some public RPCs load-balance across nodes that lag,
      // and a node that hasn't seen the tip yet can't serve state for it.
      const upstream = createPublicClient({ transport: http(options.forkUrl) });
      const tip = await upstream.getBlockNumber();
      args.push("--fork-url", options.forkUrl, "--fork-block-number", String(tip - 5n));
    }
    const anvil = spawn("anvil", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    anvil.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const spawnError = new Promise<never>((_, reject) => {
      anvil.once("error", (error) =>
        reject(new Error(`could not start anvil (is Foundry installed?): ${error.message}`)),
      );
    });

    try {
      const chainId = await Promise.race([waitForRpc(rpcUrl, anvil, () => stderr), spawnError]);
      const chain = defineChain({
        id: chainId,
        name: options.forkUrl ? `fork of chain ${chainId}` : "arena local",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

      let deployment: EvmDeployment;
      if (options.forkUrl) {
        deployment = loadDeployment(chainId);
        log(`Forked chain ${chainId}; attached to its committed deployment`);
      } else {
        log("Deploying the protocol to a fresh local chain");
        deployment = await deployFresh(rpcUrl, chainId, log);
      }
      return new Sandbox(anvil, rpcUrl, chain, deployment, Boolean(options.forkUrl), publicClient);
    } catch (error) {
      anvil.kill();
      throw error;
    }
  }

  /** A wallet for one of the sandbox's funded development accounts. */
  wallet(role: SandboxRole): ArenaWallet {
    return createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[role]),
      chain: this.chain,
      transport: http(this.rpcUrl),
    });
  }

  address(role: SandboxRole): `0x${string}` {
    return privateKeyToAccount(ANVIL_KEYS[role]).address;
  }

  async stop(): Promise<void> {
    if (this.anvil.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.anvil.once("exit", () => resolve()));
    this.anvil.kill();
    await exited;
  }
}

function loadDeployment(chainId: number): EvmDeployment {
  const path = `${CONTRACTS_DIR}deployments/${chainId}.json`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no Bonded deployment recorded for chain ${chainId} (${path})`);
  }
  return parseEvmDeployment(text, chainId);
}

/** Deploys with the production scripts (deploy.sh: Deploy + RecordDeployment). */
async function deployFresh(
  rpcUrl: string,
  chainId: number,
  log: (message: string) => void,
): Promise<EvmDeployment> {
  try {
    const { stdout } = await run("script/deploy.sh", [rpcUrl], {
      cwd: CONTRACTS_DIR,
      env: { ...process.env, DEPLOYER_PRIVATE_KEY: ANVIL_KEYS.deployer, WAITING_PERIOD: "0" },
      maxBuffer: 16 * 1024 * 1024,
    });
    log(
      stdout
        .split("\n")
        .filter((line) => line.includes("Verified on-chain"))
        .join("\n"),
    );
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`deploying to the sandbox failed: ${detail || String(error)}`, {
      cause: error,
    });
  }
  return loadDeployment(chainId);
}

async function waitForRpc(rpcUrl: string, anvil: ChildProcess, stderr: () => string) {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited: ${stderr().trim()}`);
    try {
      return await client.getChainId();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("anvil did not start within 30 seconds");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}
