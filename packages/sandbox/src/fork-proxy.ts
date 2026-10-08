import { createServer, type Server } from "node:http";

/**
 * How much a fork may ask of the live chain's RPC. anvil fetches state from the forked chain on
 * first use, so reads an agent sends to the fork can turn into requests to a public (or paid)
 * RPC. The sandbox puts this proxy between anvil and the live RPC: requests are paced to
 * `perSecond` (bursts of `burst`; past that they wait their turn) and stop at `total` for the
 * sandbox's life (a rating), after which the fork answers with an error.
 */
export interface ForkBudget {
  perSecond: number;
  burst: number;
  total: number;
}

export const DEFAULT_FORK_BUDGET: ForkBudget = { perSecond: 20, burst: 100, total: 25_000 };

export interface ForkProxy {
  url: string;
  /** Requests forwarded to the live RPC so far (each request in a batch counts). */
  readonly forwarded: number;
  close(): Promise<void>;
}

/** Starts the proxy on a free local port, forwarding to `upstream` within `budget`. */
export async function startForkProxy(upstream: string, budget: ForkBudget): Promise<ForkProxy> {
  let forwarded = 0;
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
        if (forwarded + cost > budget.total) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32005, message: "the fork's budget of live-chain requests is spent" },
            }),
          );
          return;
        }
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
