import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestationMessage as solanaMessage } from "@bonded/solana";
import { MODEL_FAMILY_CODE } from "@bonded/shared";
import { expect, it } from "vitest";
import { readLinks, toSolanaAttestation, writeLinks } from "../src/crosspost.js";

const home = {
  agentId: "2",
  score: 56,
  expectedLossBps: 415,
  reportHash: `0x${"2b".repeat(32)}`,
  mandateHash: `0x${"5a".repeat(32)}`,
  codeHash: `0x${"d4".repeat(32)}`,
  teeMeasurement: `0x${"00".repeat(32)}`,
  modelFamily: "deepseek",
  issuedAt: 1_790_603_796,
  expiresAt: 1_793_195_796,
} as const;

it("carries every field of the home score to Solana, under that chain's agent id", () => {
  const s = toSolanaAttestation(home, 7n);
  expect(s).toMatchObject({
    agentId: 7n,
    score: 56,
    expectedLossBps: 415,
    modelFamily: MODEL_FAMILY_CODE.deepseek,
    issuedAt: home.issuedAt,
    expiresAt: home.expiresAt,
  });
  expect(Buffer.from(s.reportHash).toString("hex")).toBe("2b".repeat(32));
  expect(Buffer.from(s.codeHash).toString("hex")).toBe("d4".repeat(32));
  // The message the Solana attester signs embeds the same hashes.
  expect(solanaMessage(s).includes(Buffer.from("5a".repeat(32), "hex"))).toBe(true);
});

it("reads and writes the agent-links file", () => {
  const dir = mkdtempSync(join(tmpdir(), "links-"));
  try {
    const path = join(dir, "links.json");
    writeLinks(
      [{ home: { chain: "robinhoodTestnet", agentId: "2" }, links: { solanaDevnet: "2" } }],
      path,
    );
    expect(readLinks(path)).toEqual([
      { home: { chain: "robinhoodTestnet", agentId: "2" }, links: { solanaDevnet: "2" } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
