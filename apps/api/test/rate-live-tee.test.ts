import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/rate-live-tee.sh", import.meta.url));

it("rejects remote plaintext and malformed API URLs before prompting or touching a VM", async () => {
  for (const API_URL of [
    "http://localhost@attacker.example",
    "http://localhost.attacker.example",
    "http://127.0.0.1.attacker.example",
    "http://attacker.example",
    "https://[",
    "https://example.com:bad",
  ]) {
    const result = await run("bash", [script, "1"], {
      env: { ...process.env, API_URL },
      timeout: 5000,
    }).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/API_URL must use https/);
    expect(result.stdout).not.toMatch(/Starting|Stopping|API token/);
  }
});

it("never puts a non-ASCII character right after an unbraced variable", async () => {
  // In a UTF-8 locale on macOS, bash reads `$CVM_NAME…` as one variable name and, with `set -u`,
  // stops with "unbound variable" after the token prompt. Braces end the name.
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(script, "utf8");
  const bad = [...text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(.)/gu)]
    .filter((m) => m[2]!.charCodeAt(0) > 127)
    .map((m) => m[0]);
  expect(bad).toEqual([]);
});
