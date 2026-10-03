import { expect, it } from "vitest";
import type { Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import { createApi } from "../src/index.js";
import { RateLimiter, clientAddress } from "../src/rate-limit.js";

const headers = (h: Record<string, string>) => new Headers(h);

it("limits each client and all clients together, per window", () => {
  let now = 0;
  const limiter = new RateLimiter({ perClient: 2, total: 3, windowMs: 1000, now: () => now });
  expect(limiter.allow("a")).toBe(true);
  expect(limiter.allow("a")).toBe(true);
  expect(limiter.allow("a")).toBe(false); // a's limit
  expect(limiter.allow("b")).toBe(true);
  expect(limiter.allow("c")).toBe(false); // the shared limit, whatever the address
  now = 1000; // a new window
  expect(limiter.allow("a")).toBe(true);
  expect(limiter.allow("c")).toBe(true);
});

it("takes the address Railway's edge put first in X-Forwarded-For", () => {
  // Railway strips a client's own X-Forwarded-For, so the first entry is the connecting address;
  // X-Real-IP can hold its CDN's address instead.
  expect(
    clientAddress(
      headers({ "x-forwarded-for": "5.6.7.8, 100.64.0.2", "x-real-ip": "151.101.1.1" }),
    ),
  ).toBe("5.6.7.8");
  expect(clientAddress(headers({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  expect(clientAddress(headers({}))).toBe("unknown");
});

const stubChain = (reads: { count: number }) =>
  ({
    deployment: { chainId: 46630, registry: "0x0000000000000000000000000000000000000001" },
    read: {
      readContract: async () => {
        reads.count++;
        throw new Error("no such submission");
      },
    },
  }) as unknown as ServiceChain;

it("answers 429 to a client that sends too many bounty reveals, before reading the chain", async () => {
  const reads = { count: 0 };
  const app = createApi({
    db: { pool: {} } as unknown as Database,
    chain: stubChain(reads),
    attesterKey: `0x${"11".repeat(32)}`,
    apiToken: "test-api-token-at-least-24-characters",
    revealLimit: { perClient: 2, total: 100, windowMs: 60_000 },
  });
  const reveal = (ip: string) =>
    app.request("/bounties/1/reveal", {
      method: "POST",
      body: "spec",
      headers: { "x-forwarded-for": ip },
    });
  expect((await reveal("1.1.1.1")).status).toBe(404);
  expect((await reveal("1.1.1.1")).status).toBe(404);
  expect((await reveal("1.1.1.1")).status).toBe(429);
  expect(reads.count).toBe(2); // the refused request never reached the RPC
  expect((await reveal("2.2.2.2")).status).toBe(404); // another client still gets through
});
