import { describe, expect, it } from "vitest";
import { coverageProblem, quoteApiUrl } from "../src/demo-checks.js";

const NOW = 1_800_000_000n;
const PAYOUT = 4_500_000_000n;
const active = {
  status: 1,
  coveredFrom: NOW - 3600n,
  endsAt: NOW + 30n * 86_400n,
  remainingCover: 20_000_000_000n,
};

describe("coverageProblem", () => {
  it("passes a policy that covers a breach now and can pay the claim", () => {
    expect(coverageProblem(active, NOW, PAYOUT)).toBeUndefined();
  });
  it("catches an expired policy that still shows as active until someone accrues it", () => {
    expect(coverageProblem({ ...active, endsAt: NOW - 1n }, NOW, PAYOUT)).toMatch(/ends at/);
    // And one ending during the take.
    expect(coverageProblem({ ...active, endsAt: NOW + 60n }, NOW, PAYOUT)).toMatch(/ends at/);
  });
  it("catches a new policy still in its waiting period", () => {
    expect(coverageProblem({ ...active, coveredFrom: NOW + 86_400n }, NOW, PAYOUT)).toMatch(
      /cover starts at .*waiting period/,
    );
  });
  it("catches a closed policy and one without enough cover left for the payout", () => {
    expect(coverageProblem({ ...active, status: 3 }, NOW, PAYOUT)).toMatch(/no longer active/);
    // After four 4,500 claims on 20,000 of cover, only 2,000 is left.
    expect(coverageProblem({ ...active, remainingCover: 2_000_000_000n }, NOW, PAYOUT)).toBe(
      "only $2,000 of cover is left, less than the $4,500 payout",
    );
  });
});

describe("quoteApiUrl", () => {
  it("uses BONDED_API_URL when set (from the shell or .env), else the hosted API", () => {
    expect(quoteApiUrl({ BONDED_API_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
    expect(quoteApiUrl({})).toBe("https://api-production-ba50.up.railway.app");
    expect(quoteApiUrl({ BONDED_API_URL: "  " })).toBe(
      "https://api-production-ba50.up.railway.app",
    );
  });
});

it("sees a port held on one loopback address as taken, as a dev server holds it", async () => {
  const { createServer } = await import("node:net");
  const { portIsFree } = await import("../src/demo-checks.js");
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer();
    const held = await new Promise<number | undefined>((resolve) => {
      server.once("error", () => resolve(undefined)); // no IPv6 on this machine
      server.listen(0, host, () => resolve((server.address() as { port: number }).port));
    });
    if (held === undefined) continue;
    expect(await portIsFree(held), host).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await portIsFree(held), `${host} after closing`).toBe(true);
  }
});
