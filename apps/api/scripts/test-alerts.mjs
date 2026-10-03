// Sends one sample of every alert kind to the Telegram chat, marked TEST, using the service's
// own alert code (docs/SERVICES.md "Alerts"). Run it where the secrets are set:
//   railway ssh --service keeper -- node apps/api/scripts/test-alerts.mjs
// or locally after `pnpm build`, with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment.
import process from "node:process";
import console from "node:console";
import { Alerter, telegramFromEnv } from "../dist/alerts.js";

const sink = telegramFromEnv();
if (!sink) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set.");
  process.exit(1);
}
const source = `${process.env.ROLE ?? "local"} TEST`;
const alerter = new Alerter(sink, { source });
const samples = {
  started: "Started on chain 46630.",
  crash: "Crashed (Error). Railway restarts it up to 10 times.",
  loop: "The EVM keeper has failed 3 times in a row (TypeError). It keeps retrying.",
  "keeper-lag":
    "The keeper is 12 minutes behind the chain head (block 100 of 900). New breaches aren't being claimed.",
  "stuck-claims":
    "1 breach claim(s) have been failing for over 10 minutes. The oldest: vault 0x0000000000000000000000000000000000000000, breach 0. The keeper keeps retrying; anyone can also call fileClaim.",
  "rating.failed": "A rating failed (runId 00000000-0000-0000-0000-000000000000).",
  "keeper.accrual_failed": "Premium accrual failed (chainId 46630, policyId 0).",
};
let failed = 0;
for (const [key, text] of Object.entries(samples)) {
  const ok = await alerter.alert(key, text);
  console.log(`${ok ? "sent" : "NOT SENT"}\t${key}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
