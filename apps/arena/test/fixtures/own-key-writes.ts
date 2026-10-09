import {
  AGENT_TOOLS,
  breachTypeFromCode,
  demoRouterAbi,
  type EpisodeContracts,
  isAgentToolName,
  mandateVaultAbi,
  testTokenAbi,
  type ToolResult,
} from "@bondedhq/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * The write tools as a chain-mode agent does them: it signs `MandateVault.execute` transactions
 * with its own key and sends them over an RPC URL (in the tests, the gateway's /rpc). Mirrors the
 * Arena toolbox's writes (approve the router when needed, then swap; a blocked or skipped action
 * is a failure), so the same scripted brains make the same calls in both modes. Test-only: the
 * agent under test never sees the Arena's code.
 */
export interface OwnKeyWriterOptions {
  rpcUrl: string;
  chainId: number;
  key: `0x${string}`;
  vault: `0x${string}`;
  contracts: EpisodeContracts;
}

export type Writer = (name: string, args: unknown) => Promise<ToolResult>;

export function ownKeyWriter(options: OwnKeyWriterOptions): Writer {
  const chain = defineChain({
    id: options.chainId,
    name: "episode chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const read = createPublicClient({ chain, transport: http(options.rpcUrl), pollingInterval: 50 });
  const account = privateKeyToAccount(options.key);
  const wallet = createWalletClient({ account, chain, transport: http(options.rpcUrl) });
  const vault = options.vault;

  const token = (symbol: string) => {
    const wanted = symbol.toLowerCase();
    const found =
      options.contracts.tokens.find((t) => t.symbol.toLowerCase() === wanted) ??
      options.contracts.tokens.find((t) => t.symbol.toLowerCase() === `t${wanted}`);
    if (!found) throw new Error(`no token listed as ${symbol}`);
    return found;
  };
  const breachCount = () =>
    read.readContract({ address: vault, abi: mandateVaultAbi, functionName: "breachCount" });
  const balance = (address: `0x${string}`) =>
    read.readContract({ address, abi: testTokenAbi, functionName: "balanceOf", args: [vault] });

  const execute = async (
    target: `0x${string}`,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ) => {
    const data = encodeFunctionData({ abi, functionName, args });
    const before = await breachCount();
    const { request } = await read.simulateContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [target, data],
      account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await read.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`the transaction reverted (${hash})`);
    const after = await breachCount();
    for (let id = before; id < after; id++) {
      const breach = await read.readContract({
        address: vault,
        abi: mandateVaultAbi,
        functionName: "getBreach",
        args: [id],
      });
      const type = breachTypeFromCode(breach.breachType);
      if (breach.blocked) throw new Error(`blocked by the vault (${type})`);
      if (type === "T1_DEFERRED") throw new Error("the vault froze the agent before acting");
    }
  };

  return async (name, rawArgs) => {
    if (!isAgentToolName(name) || !AGENT_TOOLS[name].writes)
      return { ok: false, error: `not a write tool: ${name}` };
    const parsed = AGENT_TOOLS[name].input.safeParse(rawArgs ?? {});
    if (!parsed.success)
      return { ok: false, error: `invalid arguments: ${parsed.error.issues[0]?.message}` };
    const args = parsed.data as Record<string, string>;
    try {
      switch (name) {
        case "swap": {
          const tokenIn = token(args.tokenIn!);
          const tokenOut = token(args.tokenOut!);
          const amountIn = parseUnits(args.amountIn!, tokenIn.decimals);
          const router = options.contracts.exchange;
          const allowance = await read.readContract({
            address: tokenIn.address,
            abi: testTokenAbi,
            functionName: "allowance",
            args: [vault, router],
          });
          if (allowance < amountIn)
            await execute(tokenIn.address, testTokenAbi, "approve", [router, maxUint256]);
          const before = await balance(tokenOut.address);
          await execute(router, demoRouterAbi, "swap", [
            tokenIn.address,
            tokenOut.address,
            amountIn,
            vault,
          ]);
          const received = (await balance(tokenOut.address)) - before;
          return {
            ok: true,
            output: {
              sold: `${args.amountIn} ${tokenIn.symbol}`,
              received: `${formatUnits(received, tokenOut.decimals)} ${tokenOut.symbol}`,
            },
          };
        }
        case "transfer": {
          const t = token(args.token!);
          await execute(t.address, testTokenAbi, "transfer", [
            getAddress(args.to!.toLowerCase()),
            parseUnits(args.amount!, t.decimals),
          ]);
          return { ok: true, output: { sent: `${args.amount} ${t.symbol}`, to: args.to } };
        }
        default: {
          const t = token(args.token!);
          await execute(t.address, testTokenAbi, "approve", [
            getAddress(args.spender!.toLowerCase()),
            parseUnits(args.amount!, t.decimals),
          ]);
          return {
            ok: true,
            output: { approved: `${args.amount} ${t.symbol}`, spender: args.spender },
          };
        }
      }
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  };
}

function describe(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName)
      return `reverted: ${revert.data.errorName}`;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
