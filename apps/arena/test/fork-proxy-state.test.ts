import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FORK_BUDGET, startForkProxy, type ForkProxy } from "@bonded/sandbox";

/**
 * Some RPCs keep old state only for a while (Robinhood Chain testnet's: about 15 minutes), and a
 * rating's fork reads state lazily at its fork block for longer than that. The proxy asks such a
 * read again at the latest block. The upstream here is a fake that has no state before "latest".
 */
interface Call {
  method: string;
  params: unknown[];
}
let upstream: Server;
let upstreamUrl: string;
let proxy: ForkProxy;
const seen: Call[][] = [];

const answer = (r: { id: unknown; method: string; params: unknown[] }) => {
  const block = r.method === "eth_getStorageAt" ? r.params[2] : r.params[1];
  if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0xb626" };
  if (r.method === "eth_call")
    return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "execution reverted" } };
  if (block !== "latest")
    return {
      jsonrpc: "2.0",
      id: r.id,
      error: { code: -32000, message: "historical state f11c01b0 is not available" },
    };
  return { jsonrpc: "2.0", id: r.id, result: r.method === "eth_getStorageAt" ? "0x2a" : "0x7" };
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body) as
        | { id: unknown; method: string; params: unknown[] }
        | { id: unknown; method: string; params: unknown[] }[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      seen.push(list.map(({ method, params }) => ({ method, params })));
      const out = list.map(answer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  proxy = await startForkProxy(upstreamUrl, DEFAULT_FORK_BUDGET);
});
afterAll(async () => {
  await proxy?.close();
  await new Promise((resolve) => upstream?.close(resolve));
});

const rpc = async (body: unknown) => {
  const r = await fetch(proxy.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as unknown;
};

describe("a fork read whose state the RPC no longer keeps", () => {
  it("is asked again at the latest block", async () => {
    seen.length = 0;
    const out = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getStorageAt",
      params: ["0x722211FDE33d059EA934dcA6f5D6340d098f4AE0", "0x1", "0x8530aac"],
    });
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, result: "0x2a" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([
      {
        method: "eth_getStorageAt",
        params: ["0x722211FDE33d059EA934dcA6f5D6340d098f4AE0", "0x1", "latest"],
      },
    ]);
  });

  it("retries only the reads in a batch that need it, and keeps the batch's order", async () => {
    seen.length = 0;
    const out = await rpc([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0xabc", "0x8530aac"] },
      { jsonrpc: "2.0", id: 3, method: "eth_getCode", params: ["0xdef", "latest"] },
    ]);
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, result: "0xb626" },
      { jsonrpc: "2.0", id: 2, result: "0x7" },
      { jsonrpc: "2.0", id: 3, result: "0x7" },
    ]);
    expect(seen[1]).toEqual([{ method: "eth_getBalance", params: ["0xabc", "latest"] }]);
  });

  it("passes other errors through unchanged", async () => {
    seen.length = 0;
    const out = await rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "eth_call",
      params: [{ to: "0xabc" }, "0x8530aac"],
    });
    expect(out).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32000, message: "execution reverted" },
    });
    expect(seen).toHaveLength(1);
  });
});
