import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attestTeeAgent, TeeVerificationError } from "../src/index.js";
import { publicAddress, safeGet } from "../src/safe-fetch.js";

// Lets a test make the name lookup hang, the way a slow or hostile DNS server would.
const dns = vi.hoisted(() => ({ stall: false }));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (...args: unknown[]) => {
    if (!dns.stall) (actual.lookup as (...a: unknown[]) => void)(...args);
  };
  return { ...actual, lookup };
});

const servers: (Server | TcpServer)[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  dns.stall = false;
  for (const t of timers.splice(0)) clearInterval(t);
  for (const s of servers.splice(0)) {
    if ("closeAllConnections" in s) s.closeAllConnections();
    s.close();
  }
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

  describe("holds the whole fetch to one deadline, not an idle timeout", () => {
    const limits = { timeoutMs: 300, maxBytes: 512 * 1024, allowLoopback: true };

    /** How long `safeGet` took to give up on `url`, and why. */
    async function giveUp(url: string): Promise<{ ms: number; error: unknown }> {
      const start = Date.now();
      const error = await safeGet(new URL(url), limits).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { ms: Date.now() - start, error };
    }

    it("gives up on a body that arrives a byte at a time", async () => {
      // The review's repro: a byte every 40 ms never trips a 300 ms idle timeout, and at that rate
      // the 512 KiB cap is hours away.
      const port = await serve((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const drip = setInterval(() => res.write(" "), 40);
        timers.push(drip);
        res.on("close", () => clearInterval(drip));
      });
      const { ms, error } = await giveUp(`http://127.0.0.1:${port}`);
      expect(ms).toBeLessThan(1_500);
      expect(String(error)).toMatch(/timed out after 300 ms/);
    });

    it("gives up on headers that arrive a line at a time", async () => {
      const server = createTcpServer((socket) => {
        socket.write("HTTP/1.1 200 OK\r\n");
        const drip = setInterval(() => socket.write("x-wait: 1\r\n"), 40);
        timers.push(drip);
        socket.on("close", () => clearInterval(drip));
        socket.on("error", () => clearInterval(drip));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      const { ms, error } = await giveUp(`http://127.0.0.1:${port}`);
      expect(ms).toBeLessThan(1_500);
      expect(String(error)).toMatch(/timed out after 300 ms/);
    });

    it("gives up on a name lookup that never answers", async () => {
      dns.stall = true;
      const { ms, error } = await giveUp("http://localhost:9");
      expect(ms).toBeLessThan(1_500);
      expect(String(error)).toMatch(/timed out after 300 ms/);
    });

    it("still returns a quick answer whole", async () => {
      const port = await serve((_req, res) => res.end('{"ok":true}'));
      await expect(safeGet(new URL(`http://127.0.0.1:${port}`), limits)).resolves.toEqual({
        status: 200,
        text: '{"ok":true}',
      });
    });
  });
});
