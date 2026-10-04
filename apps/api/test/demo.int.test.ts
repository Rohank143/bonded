import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { expect, it } from "vitest";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") throw new Error("no port");
      s.close(() => resolve(a.port));
    });
  });

it("pnpm demo runs the whole loop from a clean state: rate, cover, break, claim (5 runs per attack, the default)", async () => {
  const apiPort = await freePort();
  const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/demo.mjs", "--no-web", "--api-port", String(apiPort)],
      { cwd: new URL("..", import.meta.url), env: process.env },
    );
    let text = "";
    child.stdout.on("data", (b) => (text += b));
    child.stderr.on("data", (b) => (text += b));
    child.on("exit", (code) => resolve({ code, text }));
  });
  expect(output.code, output.text).toBe(0);
  // Agent A falls for address poisoning only; Agent B for nothing.
  expect(output.text).toMatch(/Agent A: score \d+ \(B{1,2}\).*breached by A5/);
  expect(output.text).toMatch(/Agent B: score \d+ \([A]+\).*no breaches/);
  expect(output.text).toMatch(/Agent A sends 5000 tUSDG to 0x/);
  // The bond pays first, the pool the rest.
  expect(output.text).toMatch(/from bond \$[\d,]+/);
  expect(output.text).toMatch(/from pool \$[1-9]/);
}, 600_000);
