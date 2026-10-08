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

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let cost = 1;
        try {
          const parsed = JSON.parse(body) as unknown;
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
        try {
          const response = await fetch(upstream, {
            method: "POST",
            headers: { "content-type": req.headers["content-type"] ?? "application/json" },
            body,
            signal: AbortSignal.timeout(30_000),
          });
          res.writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "application/json",
          });
          res.end(Buffer.from(await response.arrayBuffer()));
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
