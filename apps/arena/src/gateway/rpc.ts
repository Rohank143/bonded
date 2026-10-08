import { mandateVaultAbi } from "@bonded/shared";
import {
  decodeFunctionData,
  isAddressEqual,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
  toFunctionSelector,
} from "viem";
import type { ArenaToolbox } from "../toolbox.js";

/**
 * The chain-mode JSON-RPC endpoint (`POST /e/{t}/rpc`): a proxy to the episode's sandbox chain
 * for an agent that signs its own transactions.
 *
 * The agent under test is untrusted, and the sandbox is an anvil node whose cheat methods could
 * rewrite balances, mine blocks, impersonate accounts or reveal the node's setup. So:
 * - only the methods below pass: standard reads (eth_call, eth_estimateGas and eth_simulateV1
 *   included: their state overrides last only for that call), gas and fee queries, and one write,
 *   eth_sendRawTransaction. Every anvil_, hardhat_, evm_, debug_, trace_, ots_, txpool_, personal_
 *   and eth_sign* method, eth_sendTransaction (anvil would sign it with an unlocked development
 *   key), eth_accounts, filters and subscriptions are refused;
 * - a raw transaction must be signed by the episode's agent key, call the episode's vault's
 *   execute() with no ETH, and be a plain (legacy, EIP-2930 or EIP-1559) transaction for this
 *   chain. The anvil development keys are public, so without the signer check an agent could act
 *   as the operator, depositor or attester;
 * - each transaction is a step in the toolbox's trace (ArenaToolbox.recordTransaction): it counts
 *   toward the step cap, stops when the episode ends, and its breaches are read back.
 *
 * Reads see the whole sandbox chain, as an agent on a public chain would. Attack content never
 * lives on chain (it is planted in the world simulator, served only through the episode's tools),
 * so reading other contracts' state reveals nothing about the attack.
 */
export const RPC_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_syncing",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_blobBaseFee",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getProof",
  "eth_call",
  "eth_estimateGas",
  // Read-only: overrides apply to the simulation alone (the SDK's dry runs use it).
  "eth_simulateV1",
  "eth_createAccessList",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockReceipts",
  "eth_getBlockTransactionCountByNumber",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
]);

const EXECUTE_SELECTOR = toFunctionSelector("execute(address,bytes)");
const ALLOWED_TX_TYPES = new Set(["legacy", "eip2930", "eip1559"]);

/** What the proxy needs to know about one episode. */
export interface RpcBinding {
  /** The sandbox's own RPC URL (never shown to the agent). */
  upstream: string;
  chainId: number;
  vault: `0x${string}`;
  /** The only key whose transactions are accepted: the vault's agent. */
  agent: `0x${string}`;
  /**
   * What `web3_clientVersion` answers: the live chain's own node version on a fork, so the
   * sandbox node doesn't name itself. Without it the sandbox's answer passes through.
   */
  clientVersion?: string;
  toolbox: ArenaToolbox;
  /**
   * The episode's budget of calls to the sandbox node (see `RpcBudget`); a simulation is charged
   * one per call it simulates.
   */
  budget?: RpcBudget;
  /**
   * The episode's gas budget: every call, estimate and simulated call is charged the gas it may
   * use, so EVM execution per second is bounded, not just the number of requests.
   */
  gas?: RpcBudget;
  /** Aborted when the episode ends: nothing more is forwarded, and calls in flight stop. */
  signal?: AbortSignal;
}

/**
 * How much of the sandbox node one episode may use: a total number of upstream calls, and a rate
 * (a token bucket), so an agent can't turn the RPC endpoint into unbounded work for the node.
 */
export class RpcBudget {
  private used = 0;
  private allowance: number;
  private refilled = Date.now();

  constructor(
    private readonly total: number,
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.allowance = burst;
  }

  /** Takes `amount` from the budget; false (taking nothing) when the total or the rate is spent. */
  take(amount = 1): boolean {
    const now = Date.now();
    this.allowance = Math.min(
      this.burst,
      this.allowance + ((now - this.refilled) / 1000) * this.perSecond,
    );
    this.refilled = now;
    if (this.used + amount > this.total || this.allowance < amount) return false;
    this.used += amount;
    this.allowance -= amount;
    return true;
  }
}

export interface RpcLimits {
  /** Most requests in one batch. */
  batch: number;
  /** Per upstream call. */
  timeoutMs: number;
  /** Largest single upstream answer passed on (a wide eth_getLogs on a fork can be huge). */
  responseBytes: number;
  /** Largest total of answers for one HTTP request, a batch included. */
  requestResponseBytes: number;
  /** Gas any eth_call, eth_estimateGas, eth_createAccessList or simulated call may use. */
  callGas: bigint;
  /** The gas such a call gets when it names none. */
  defaultCallGas: bigint;
  /** Blocks and calls one eth_simulateV1 may simulate. */
  simulateBlocks: number;
  simulateCalls: number;
}

/** What is left of one HTTP request's response budget. */
interface RequestBudget {
  bytes: number;
}

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params: unknown[];
}
interface RpcError {
  code: number;
  message: string;
}
type RpcResponse = { jsonrpc: "2.0"; id: Id } & ({ result: unknown } | { error: RpcError });

const failure = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Handles a JSON-RPC body: one request or a batch. Never throws. */
export async function handleRpc(
  body: unknown,
  binding: RpcBinding,
  limits: RpcLimits,
): Promise<RpcResponse | RpcResponse[]> {
  const spent: RequestBudget = { bytes: limits.requestResponseBytes };
  if (Array.isArray(body)) {
    if (body.length === 0) return failure(null, -32600, "empty batch");
    if (body.length > limits.batch)
      return failure(null, -32600, `a batch can hold at most ${limits.batch} requests`);
    const out: RpcResponse[] = [];
    // In order, one at a time: a batch that sends a transaction then reads its receipt works.
    for (const item of body) out.push(await handleOne(item, binding, limits, spent));
    return out;
  }
  return handleOne(body, binding, limits, spent);
}

async function handleOne(
  raw: unknown,
  binding: RpcBinding,
  limits: RpcLimits,
  spent: RequestBudget,
): Promise<RpcResponse> {
  const request = parseRequest(raw);
  if (!("method" in request)) return request;
  const { id, method } = request;
  if (!RPC_ALLOWED_METHODS.has(method))
    return failure(id, -32601, `method ${method} is not available in the Arena`);
  if (binding.signal?.aborted) return failure(id, -32000, "the episode is over");
  if (method === "web3_clientVersion" && binding.clientVersion)
    return { jsonrpc: "2.0", id, result: binding.clientVersion };
  if (spent.bytes <= 0)
    return failure(id, -32005, "this request's response budget is spent; send fewer calls");
  const params = boundParams(method, request.params, limits);
  if ("error" in params) return failure(id, -32602, params.error);
  if (binding.budget && !binding.budget.take(params.calls))
    return failure(id, -32005, "too many RPC calls for this episode; slow down");
  if (params.gas > 0n && binding.gas && !binding.gas.take(Number(params.gas)))
    return failure(id, -32005, "too much gas used by calls in this episode; slow down");
  if (method === "eth_sendRawTransaction")
    return sendRaw({ ...request, params: params.params }, binding, limits, spent);
  try {
    return { ...(await forward(binding, method, params.params, limits, spent)), id };
  } catch (error) {
    return failure(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

const CALL_METHODS = new Set(["eth_call", "eth_estimateGas", "eth_createAccessList"]);

/**
 * Bounds the work one call can ask of the node: calls and estimates get at most `callGas` (memory
 * a call can fill, and so the size of its answer, grows with its gas), and a simulation at most a
 * few blocks and calls, each with that gas.
 */
function boundParams(
  method: string,
  params: unknown[],
  limits: RpcLimits,
): { params: unknown[]; calls: number; gas: bigint } | { error: string } {
  let gasTotal = 0n;
  const capGas = (call: unknown) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return call;
    const c = call as Record<string, unknown>;
    let gas = limits.defaultCallGas;
    try {
      if (typeof c.gas === "string" || typeof c.gas === "number") gas = BigInt(c.gas);
    } catch {
      // Unparseable gas: the default stands.
    }
    if (gas > limits.callGas) gas = limits.callGas;
    if (gas < 0n) gas = 0n;
    gasTotal += gas;
    return { ...c, gas: `0x${gas.toString(16)}` };
  };
  if (CALL_METHODS.has(method)) {
    const bounded = [capGas(params[0]), ...params.slice(1)];
    return { params: bounded, calls: 1, gas: gasTotal };
  }
  if (method !== "eth_simulateV1") return { params, calls: 1, gas: 0n };
  const payload = params[0] as { blockStateCalls?: unknown } | undefined;
  const blocks = payload?.blockStateCalls;
  if (!Array.isArray(blocks)) return { error: "eth_simulateV1 needs blockStateCalls" };
  if (blocks.length > limits.simulateBlocks)
    return { error: `simulate at most ${limits.simulateBlocks} blocks` };
  let calls = 0;
  const bounded = blocks.map((block) => {
    const b = (block ?? {}) as Record<string, unknown>;
    const list = Array.isArray(b.calls) ? b.calls : [];
    calls += list.length;
    const overrides = (b.blockOverrides ?? undefined) as Record<string, unknown> | undefined;
    return {
      ...b,
      calls: list.map(capGas),
      ...(overrides
        ? {
            blockOverrides: {
              ...overrides,
              gasLimit: `0x${(limits.callGas * BigInt(Math.max(1, list.length))).toString(16)}`,
            },
          }
        : {}),
    };
  });
  if (calls > limits.simulateCalls)
    return { error: `simulate at most ${limits.simulateCalls} calls` };
  return {
    params: [{ ...(payload as object), blockStateCalls: bounded }, ...params.slice(1)],
    calls: Math.max(1, calls),
    gas: gasTotal,
  };
}

function parseRequest(raw: unknown): RpcRequest | RpcResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return failure(null, -32600, "invalid request");
  const r = raw as Record<string, unknown>;
  const id: Id =
    typeof r.id === "string" || typeof r.id === "number" || r.id === null ? (r.id as Id) : null;
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string" || r.method.length > 64)
    return failure(id, -32600, "invalid request");
  if (r.params !== undefined && !Array.isArray(r.params))
    return failure(id, -32602, "params must be an array");
  return { jsonrpc: "2.0", id, method: r.method, params: (r.params as unknown[]) ?? [] };
}

/**
 * Checks a signed transaction before it reaches the chain, then sends it as a toolbox step. The
 * response is the chain's own (the hash, or its error), so the agent sees what a real node says.
 */
async function sendRaw(
  request: RpcRequest,
  binding: RpcBinding,
  limits: RpcLimits,
  spent: RequestBudget,
): Promise<RpcResponse> {
  const { id, params } = request;
  const raw = params[0];
  if (params.length !== 1 || typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw))
    return failure(id, -32602, "expected one signed transaction as hex");
  const checked = await checkTransaction(raw as TransactionSerialized, binding);
  if ("error" in checked) return failure(id, -32000, checked.error);

  let response: RpcResponse | undefined;
  const result = await binding.toolbox.recordTransaction(checked.call, async () => {
    response = { ...(await forward(binding, request.method, params, limits, spent)), id };
    if ("error" in response) throw new Error(response.error.message);
    return response.result as `0x${string}`;
  });
  // No response means the transaction was never sent: the step cap or the episode's end.
  if (!response) return failure(id, -32000, result.ok ? "not sent" : result.error);
  return response;
}

/** The checks on a raw transaction, and its decoded vault call for the trace. */
export async function checkTransaction(
  raw: TransactionSerialized,
  binding: Pick<RpcBinding, "chainId" | "vault" | "agent">,
): Promise<{ call: { target: `0x${string}`; data: `0x${string}` } } | { error: string }> {
  let tx;
  let from: `0x${string}`;
  try {
    tx = parseTransaction(raw);
    from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  } catch {
    return { error: "not a valid signed transaction" };
  }
  if (!tx.type || !ALLOWED_TX_TYPES.has(tx.type))
    return { error: `transaction type ${tx.type} is not accepted (use EIP-1559 or legacy)` };
  if (tx.chainId !== binding.chainId)
    return { error: `the transaction must be signed for chain ${binding.chainId}` };
  if (!isAddressEqual(from, binding.agent))
    return { error: "the transaction must be signed by this episode's agent key" };
  if (!tx.to || !isAddressEqual(tx.to, binding.vault))
    return { error: "transactions may only call this episode's vault" };
  if ((tx.value ?? 0n) !== 0n) return { error: "the vault takes no ETH" };
  if (!tx.data || tx.data.slice(0, 10).toLowerCase() !== EXECUTE_SELECTOR)
    return { error: "only the vault's execute(target, data) may be called" };
  try {
    const { args } = decodeFunctionData({ abi: mandateVaultAbi, data: tx.data });
    const [target, data] = args as readonly [`0x${string}`, `0x${string}`];
    return { call: { target, data } };
  } catch {
    return { error: "the execute() call could not be decoded" };
  }
}

/**
 * One call to the sandbox node, with a time limit and a size limit (the smaller of the per-answer
 * cap and what is left of the request's budget, which the answer then uses up). It stops when the
 * episode ends.
 */
async function forward(
  binding: Pick<RpcBinding, "upstream" | "signal">,
  method: string,
  params: unknown[],
  limits: RpcLimits,
  spent: RequestBudget,
): Promise<{ jsonrpc: "2.0"; result: unknown } | { jsonrpc: "2.0"; error: RpcError }> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const response = await fetch(binding.upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: binding.signal ? AbortSignal.any([timeout, binding.signal]) : timeout,
  });
  const text = await readCapped(response, Math.min(limits.responseBytes, spent.bytes));
  spent.bytes -= text === undefined ? spent.bytes : Buffer.byteLength(text);
  if (text === undefined)
    return {
      jsonrpc: "2.0",
      error: { code: -32005, message: "response too large; narrow the request" },
    };
  const parsed = JSON.parse(text) as { result?: unknown; error?: RpcError };
  if (parsed.error)
    return {
      jsonrpc: "2.0",
      error: { code: parsed.error.code ?? -32603, message: String(parsed.error.message ?? "") },
    };
  return { jsonrpc: "2.0", result: parsed.result ?? null };
}

/** The response body as text, or undefined (and the read abandoned) once it passes `limit`. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The node version a live chain reports, asked once per URL; undefined if it can't be reached.
 * Used so a fork answers web3_clientVersion like the chain it copies.
 */
const clientVersions = new Map<string, Promise<string | undefined>>();
export function liveClientVersion(url: string): Promise<string | undefined> {
  let found = clientVersions.get(url);
  if (!found) {
    found = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json() as Promise<{ result?: unknown }>)
      .then((r) => (typeof r.result === "string" ? r.result.slice(0, 200) : undefined))
      .catch(() => undefined);
    clientVersions.set(url, found);
  }
  return found;
}
