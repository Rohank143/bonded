import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { attestTeeAgent, TeeVerificationError } from "../src/index.js";
import { publicAddress } from "../src/safe-fetch.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const expectation = {
  codeHash: `0x${"11".repeat(32)}`,
  composeHash: `0x${"22".repeat(32)}`,
} as const;

describe("fetching an operator's TEE URL", () => {
  it("knows which addresses are public", () => {
    for (const ok of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(publicAddress(ok), ok).toBe(true);
    for (const no of [
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "fd00::1",
      "fe80::1",
      "224.0.0.1",
      "not-an-ip",
    ])
      expect(publicAddress(no), no).toBe(false);
    expect(publicAddress("127.0.0.1", true)).toBe(true);
    expect(publicAddress("::1", true)).toBe(true);
    expect(publicAddress("10.0.0.1", true)).toBe(false);
  });

  it("doesn't follow a redirect to an internal service", async () => {
    // The review's proof of concept: a redirect to an internal admin URL was followed.
    let hit: string | undefined;
    const internal = await serve((req, res) => {
      hit = req.url;
      res.end("{}");
    });
    const redirector = await serve((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internal}/admin/anything?x=1` });
      res.end();
    });
    await expect(
      attestTeeAgent({
        ...expectation,
        url: `http://localhost:${redirector}`,
        allowLoopback: true,
      }),
    ).rejects.toThrow(/redirects are not followed/);
    expect(hit).toBeUndefined();
  });

  it("refuses private, internal and loopback addresses unless loopback is allowed", async () => {
    let hits = 0;
    const port = await serve((_req, res) => {
      hits++;
      res.end("{}");
    });
    for (const url of [
      `https://127.0.0.1:${port}`,
      `http://127.0.0.1:${port}`,
      `https://localhost:${port}`,
      "https://169.254.169.254",
      "https://10.1.2.3",
      "https://[::1]:443",
    ])
      await expect(attestTeeAgent({ ...expectation, url }), url).rejects.toBeInstanceOf(
        TeeVerificationError,
      );
    expect(hits).toBe(0);
  });

  it("caps the size of the answer", async () => {
    const port = await serve((_req, res) => res.end("x".repeat(600 * 1024)));
    await expect(
      attestTeeAgent({ ...expectation, url: `http://127.0.0.1:${port}`, allowLoopback: true }),
    ).rejects.toThrow(/over 524288 bytes/);
  });
});
