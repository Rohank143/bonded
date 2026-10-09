import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type EvmDeployment, parseEvmDeployment } from "@bondedhq/shared";
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
import {
  DEFAULT_FORK_BUDGET,
  type ForkBudget,
  type ForkProxy,
  type ForkScope,
  startForkProxy,
} from "./fork-proxy.js";

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

/**
 * What the agent's tools need from a chain: its deployment, a reader and the agent's wallet. A
 * sandbox is one; a live chain (testnet, for the demo's break-it run) can be another.
 */
export type ChainHandle = Pick<Sandbox, "deployment" | "publicClient"> & {
  wallet(role: SandboxRole): ReturnType<Sandbox["wallet"]>;
};

export interface SandboxOptions {
  /**
   * RPC of a live chain to fork (e.g. Robinhood Chain testnet). The sandbox then attaches to
   * the committed deployment for that chain. Without it, a fresh local chain is started and
   * the protocol is deployed to it.
   */
  forkUrl?: string;
  /** Explicit deployment for a fork, including ephemeral local chains. */
  forkDeployment?: EvmDeployment;
  /**
   * How much the fork may ask of the live RPC (fork-proxy.ts): paced and capped for the sandbox's
   * life. Default DEFAULT_FORK_BUDGET; false sends anvil to the live RPC directly.
   */
  forkBudget?: ForkBudget | false;
  /** Port for anvil; a free one is picked by default. */
  port?: number;
  /** Picks the free port (tests stand in a port that is already taken). */
  pickPort?: () => Promise<number>;
  /** Progress messages (deploy output, etc.). */
  log?: (message: string) => void;
}

type ArenaWallet = WalletClient<Transport, Chain, Account>;

/**
 * anvil's command line for a sandbox. `--max-persisted-states 0` keeps old chain states out of
 * ~/.foundry/anvil/tmp: by default anvil moves them there and never deletes the folder, even on a
 * clean exit, so every rating left hundreds of megabytes to gigabytes behind. Recent states stay
 * in memory, which covers the few blocks back the rating sandbox forks from.
 */
export function anvilArgs(port: number, fork: boolean): string[] {
  const args = ["--port", String(port), "--silent", "--max-persisted-states", "0"];
  // A chain id unique to this sandbox (its port is unique while it runs), so sandboxes
  // started at the same time write separate deployment files instead of racing on one.
  if (!fork) args.push("--chain-id", String(313_370_000 + port));
  return args;
}

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
    /** The live chain's RPC a fork was made from (may hold an API key: never shown to agents). */
    readonly forkUrl?: string,
    private readonly forkProxy?: ForkProxy,
  ) {}

  /** Requests the fork has sent to the live RPC so far, when its budget is enforced. */
  get forkFetches(): number | undefined {
    return this.forkProxy?.forwarded;
  }

  /**
   * Charges the fork's live-chain requests to an agent until the scope is closed (fork-proxy.ts):
   * a RemoteAgent opens one around each episode. Undefined when the sandbox isn't a budgeted fork.
   */
  forkScope(): ForkScope | undefined {
    return this.forkProxy?.openScope();
  }

  /**
   * Starts anvil on a free port. A free port can be taken by another process between picking it
   * and anvil binding it (parallel test runs start many sandboxes at once): then anvil exits, or
   * the RPC answering on that port is someone else's chain. Either way it is detected (the chain
   * id is checked) and the sandbox starts again on another port, up to five times.
   */
  static async start(options: SandboxOptions = {}): Promise<Sandbox> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await Sandbox.startOnce(options);
      } catch (error) {
        if (!(error instanceof PortTakenError) || options.port !== undefined || attempt >= 5)
          throw error;
      }
    }
  }

  private static async startOnce(options: SandboxOptions): Promise<Sandbox> {
    const log = options.log ?? (() => {});
    const port = options.port ?? (await (options.pickPort ?? freePort)());
    const rpcUrl = `http://127.0.0.1:${port}`;

    // A balance for the dev accounts that only this anvil has: how it is told apart from another
    // process's anvil that took the port first (on a fresh chain or a fork alike).
    const marker = 10_000 + randomInt(1, 1_000);
    const args = [...anvilArgs(port, Boolean(options.forkUrl)), "--balance", String(marker)];
    let proxy: ForkProxy | undefined;
    // The chain id this sandbox's anvil will answer with (anvilArgs gives a fresh chain its own).
    let expectedChainId: number | undefined = options.forkUrl ? undefined : 313_370_000 + port;
    if (options.forkUrl) {
      // Fork a few blocks behind the tip: some public RPCs load-balance across nodes that lag,
      // and a node that hasn't seen the tip yet can't serve state for it.
      const upstream = createPublicClient({ transport: http(options.forkUrl) });
      const tip = await upstream.getBlockNumber();
      expectedChainId = await upstream.getChainId();
      proxy =
        options.forkBudget === false
          ? undefined
          : await startForkProxy(options.forkUrl, options.forkBudget ?? DEFAULT_FORK_BUDGET);
      args.push(
        "--fork-url",
        proxy?.url ?? options.forkUrl,
        "--fork-block-number",
        String(tip - 5n),
      );
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
      if (expectedChainId !== undefined && chainId !== expectedChainId)
        throw new PortTakenError(`port ${port} is answered by another chain (${chainId})`);
      const probe = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
      const balance = await probe.getBalance({
        address: privateKeyToAccount(ANVIL_KEYS.deployer).address,
      });
      if (balance !== BigInt(marker) * 10n ** 18n || hasExited(anvil))
        throw new PortTakenError(`port ${port} is answered by another anvil`);
      const chain = defineChain({
        id: chainId,
        name: options.forkUrl ? `fork of chain ${chainId}` : "arena local",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      // anvil mines instantly, so poll for receipts often rather than every 4 seconds.
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
        pollingInterval: 50,
      });

      let deployment: EvmDeployment;
      if (options.forkUrl) {
        deployment = options.forkDeployment ?? loadDeployment(chainId);
        if (deployment.chainId !== chainId) throw new Error("fork deployment chain mismatch");
        log(`Forked chain ${chainId}; attached to its committed deployment`);
      } else {
        log("Deploying the protocol to a fresh local chain");
        deployment = await deployFresh(rpcUrl, chainId, log);
        // The addresses now live in memory; the file only existed to hand them over.
        rmSync(`${CONTRACTS_DIR}${SANDBOX_DEPLOYMENTS}/${chainId}.json`, { force: true });
      }
      return new Sandbox(
        anvil,
        rpcUrl,
        chain,
        deployment,
        Boolean(options.forkUrl),
        publicClient,
        options.forkUrl,
        proxy,
      );
    } catch (error) {
      anvil.kill();
      await proxy?.close();
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

  /**
   * A wallet that sends as any address, with test ETH for gas (anvil impersonation). Used for
   * the attacker, whose addresses (such as a lookalike) have no key the Arena knows.
   */
  async impersonate(address: `0x${string}`): Promise<WalletClient<Transport, Chain, Account>> {
    await this.anvil_("anvil_impersonateAccount", [address]);
    await this.fund(address);
    return createWalletClient({
      account: address,
      chain: this.chain,
      transport: http(this.rpcUrl),
    });
  }

  /**
   * Gives an address test ETH for gas (anvil's balance cheat, local to the sandbox). Used for a
   * chain-mode agent's own key, which signs its transactions itself.
   */
  async fund(address: `0x${string}`, wei: bigint = 10n ** 18n): Promise<void> {
    await this.anvil_("anvil_setBalance", [address, `0x${wei.toString(16)}`]);
  }

  private anvil_(method: string, params: unknown[]): Promise<unknown> {
    return this.publicClient.request({ method: method as never, params: params as never });
  }

  address(role: SandboxRole): `0x${string}` {
    return privateKeyToAccount(ANVIL_KEYS[role]).address;
  }

  async stop(): Promise<void> {
    if (!hasExited(this.anvil)) {
      const exited = new Promise<void>((resolve) => this.anvil.once("exit", () => resolve()));
      this.anvil.kill();
      await exited;
    }
    await this.forkProxy?.close();
  }
}

/**
 * Where a fresh sandbox's deploy writes its addresses (relative to contracts/evm): a git-ignored
 * folder, so a run that dies before cleaning up can't leave a file beside the committed
 * deployments (where it could be committed, and where the committed-files test would read it).
 */
const SANDBOX_DEPLOYMENTS = "deployments/sandbox";

function loadDeployment(chainId: number, dir = "deployments"): EvmDeployment {
  const path = `${CONTRACTS_DIR}${dir}/${chainId}.json`;
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
      // Every role is set explicitly and .env is ignored, so testnet settings (a real attester
      // or key in .env or the shell) never leak into a local sandbox.
      env: {
        ...process.env,
        BONDED_SKIP_DOTENV: "1",
        DEPLOYER_PRIVATE_KEY: ANVIL_KEYS.deployer,
        ATTESTER: privateKeyToAccount(ANVIL_KEYS.deployer).address,
        COUNCIL: privateKeyToAccount(ANVIL_KEYS.deployer).address,
        WAITING_PERIOD: "0",
        DEPLOYMENTS_DIR: SANDBOX_DEPLOYMENTS,
      },
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
  return loadDeployment(chainId, SANDBOX_DEPLOYMENTS);
}

/** True once the process has ended, whether it exited or was killed by a signal. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Another process took the port picked for anvil (see `Sandbox.start`). */
class PortTakenError extends Error {}

async function waitForRpc(rpcUrl: string, anvil: ChildProcess, stderr: () => string) {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hasExited(anvil)) {
      const said = stderr().trim();
      if (/address already in use|addrinuse|os error 48|os error 98/i.test(said))
        throw new PortTakenError(`anvil couldn't bind its port: ${said}`);
      throw new Error(`anvil exited: ${said}`);
    }
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
