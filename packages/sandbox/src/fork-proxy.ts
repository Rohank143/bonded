import { createServer, type Server } from "node:http";

/**
 * How much a fork may ask of the live chain's RPC. anvil fetches state from the forked chain on
 * first use, so reads an agent sends to the fork can turn into requests to a public (or paid)
 * RPC. The sandbox puts this proxy between anvil and the live RPC. Requests are paced to
 * `perSecond` (bursts of `burst`; past that they wait their turn).
 *
 * What an agent causes is counted apart: while an agent's episode runs, its requests are
 * charged to a scope (`openScope`) with its own cap (`perScope`), within an overall agent
 * allowance (`agentTotal`). Past either, the agent's requests are refused, and only the agent's:
 * the rating's own setup and judging draw on everything else, up to a high safety ceiling
 * (`total`), so an agent can't spend the budget a later episode's setup needs.
 */
export interface ForkBudget {
  perSecond: number;
  burst: number;
  /** Requests one agent scope (an episode) may cause. */
  perScope: number;
  /** Requests all agent scopes together may cause over the sandbox's life. */
  agentTotal: number;
  /** A safety ceiling on everything, setup and judging included. */
  total: number;
}

export const DEFAULT_FORK_BUDGET: ForkBudget = {
  perSecond: 20,
  burst: 100,
  perScope: 500,
  agentTotal: 20_000,
  total: 200_000,
};

/** One agent's share of fork requests, open while its episode runs. */
export interface ForkScope {
  /** Requests charged to it so far. */
  readonly used: number;
  /** Whether it ran out (or the overall agent allowance did) and a request was refused. */
  readonly exhausted: boolean;
  close(): void;
}

export interface ForkProxy {
  url: string;
  /** Requests forwarded to the live RPC so far (each request in a batch counts). */
  readonly forwarded: number;
  /** Requests agent scopes have caused so far. */
  readonly agentForwarded: number;
  /** Charges requests to a new agent scope until it is closed (one scope at a time). */
  openScope(): ForkScope;
  close(): Promise<void>;
}

/**
 * State reads anvil sends at the fork block, with the index of their block parameter. Some RPCs
 * keep old state only for a while (Robinhood Chain testnet's: about 15 minutes in Oct 2026), and a
 * rating reads state lazily for longer than that, so a slot first read late fails with "historical
 * state … is not available". Those reads are asked again at the latest block: a slot nothing has
 * written since the fork reads the same, and one that changed reads its newer value.
 */
const STATE_READS: Record<string, number> = {
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
};
const STATE_GONE = /historical state|missing trie node/i;

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}
interface RpcResponse {
  id?: unknown;
  error?: { message?: string };
}

/** The request asked again at the latest block, if it is a state read whose state was gone. */
function atLatest(request: RpcRequest, response: RpcResponse | undefined): RpcRequest | undefined {
  const at = request.method ? STATE_READS[request.method] : undefined;
  if (at === undefined || !Array.isArray(request.params) || request.params.length <= at) return;
  if (!STATE_GONE.test(response?.error?.message ?? "")) return;
  const params = [...request.params];
  params[at] = "latest";
  return { ...request, params };
}

/** Starts the proxy on a free local port, forwarding to `upstream` within `budget`. */
export async function startForkProxy(upstream: string, budget: ForkBudget): Promise<ForkProxy> {
  let forwarded = 0;
  let agentForwarded = 0;
  let scope: { used: number; exhausted: boolean; open: boolean } | undefined;
  let allowance = budget.burst;
  let refilled = Date.now();
  // Paced in order: each request waits until the bucket has room for it.
  let queue: Promise<void> = Promise.resolve();
  const pace = (cost: number) => {
    const turn = queue.then(async () => {
      for (;;) {
        const now = Date.now();
        allowance = Math.min(
          budget.burst,
          allowance + ((now - refilled) / 1000) * budget.perSecond,
        );
        refilled = now;
        if (allowance >= Math.min(cost, budget.burst)) {
          allowance -= cost;
          return;
        }
        const wait = ((Math.min(cost, budget.burst) - allowance) / budget.perSecond) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, wait)));
      }
    });
    queue = turn.catch(() => {});
    return turn;
  };

  // Asks again at the latest block the state reads whose state was gone, and puts their answers
  // in place of the errors. Returns undefined when there is nothing to retry. The retries count
  // against the overall ceiling and are paced, but aren't charged to the agent's scope: they are
  // the RPC's shortfall, not more reads.
  const retryAtLatest = async (
    parsed: unknown,
    bytes: Buffer,
    send: (payload: string) => Promise<Response>,
  ): Promise<Buffer | undefined> => {
    if (parsed === undefined) return;
    let answer: unknown;
    try {
      answer = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return;
    }
    const requests = (Array.isArray(parsed) ? parsed : [parsed]) as RpcRequest[];
    const answers = (Array.isArray(answer) ? answer : [answer]) as RpcResponse[];
    const byId = new Map(answers.map((a) => [JSON.stringify(a?.id ?? null), a]));
    const again = requests
      .map((r) => atLatest(r, byId.get(JSON.stringify(r?.id ?? null))))
      .filter((r): r is RpcRequest => r !== undefined);
    if (again.length === 0 || forwarded + again.length > budget.total) return;
    forwarded += again.length;
    await pace(again.length);
    // A single request is asked again on its own, in case the RPC takes no batches.
    const response = await send(JSON.stringify(Array.isArray(parsed) ? again : again[0]));
    if (!response.ok) return;
    const retried = (await response.json()) as RpcResponse | RpcResponse[];
    for (const a of Array.isArray(retried) ? retried : [retried])
      byId.set(JSON.stringify(a?.id ?? null), a);
    const merged = answers.map((a) => byId.get(JSON.stringify(a?.id ?? null)) ?? a);
    return Buffer.from(JSON.stringify(Array.isArray(answer) ? merged : merged[0]));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let cost = 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
          if (Array.isArray(parsed)) cost = Math.max(1, parsed.length);
        } catch {
          // Not JSON: forwarded as one request, and the upstream answers it.
        }
        const refuse = (message: string) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message } }));
        };
        const charged = scope?.open ? scope : undefined;
        if (charged) {
          if (
            charged.exhausted ||
            charged.used + cost > budget.perScope ||
            agentForwarded + cost > budget.agentTotal
          ) {
            charged.exhausted = true;
            return refuse("the agent's budget of live-chain requests is spent");
          }
          charged.used += cost;
          agentForwarded += cost;
        }
        if (forwarded + cost > budget.total)
          return refuse("the fork's budget of live-chain requests is spent");
        forwarded += cost;
        await pace(cost);
        const send = (payload: string) =>
          fetch(upstream, {
            method: "POST",
            headers: { "content-type": req.headers["content-type"] ?? "application/json" },
            body: payload,
            signal: AbortSignal.timeout(30_000),
          });
        try {
          const response = await send(body);
          const bytes = Buffer.from(await response.arrayBuffer());
          const retried = response.ok ? await retryAtLatest(parsed, bytes, send) : undefined;
          res.writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "application/json",
          });
          res.end(retried ?? bytes);
        } catch {
          res.writeHead(502).end();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get forwarded() {
      return forwarded;
    },
    get agentForwarded() {
      return agentForwarded;
    },
    openScope() {
      const opened = { used: 0, exhausted: false, open: true };
      scope = opened;
      return {
        get used() {
          return opened.used;
        },
        get exhausted() {
          return opened.exhausted;
        },
        close() {
          opened.open = false;
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
