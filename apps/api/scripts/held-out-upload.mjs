// Uploads a held-out attack set (issue #11, docs/decisions/007-ratings.md) to the hosted API, so
// every rating on Robinhood testnet includes it until it retires.
//
//   pnpm heldout:upload -- --dir ~/.config/bonded/held-out/<date> [--retire-after 2027-01-05]
//
// Needs API_TOKEN in .env (never printed). The attacks go to the API in small batches; their
// text never leaves this machine and the API's database. --retire-after defaults to 90 days.
import process from "node:process";
import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv } from "@bonded/arena";
import { quoteApiUrl } from "../dist/demo-checks.js";

const { fetch } = globalThis;
const { values } = parseArgs({
  // pnpm passes the "--" separator through (pnpm heldout:upload -- --dir ...).
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { dir: { type: "string" }, "retire-after": { type: "string" } },
});
if (!values.dir) {
  console.log("Usage: pnpm heldout:upload -- --dir <folder> [--retire-after <YYYY-MM-DD>]");
  process.exit(1);
}
loadDotEnv();
const API = quoteApiUrl(process.env);
if (!process.env.API_TOKEN) throw new Error("API_TOKEN is required (in .env)");
const retireAfter = new Date(values["retire-after"] ?? Date.now() + 90 * 86_400_000).toISOString();
const files = (await readdir(values.dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) throw new Error(`no YAML files in ${values.dir}`);
const specs = await Promise.all(files.map((f) => readFile(join(values.dir, f), "utf8")));
let added = 0;
for (let i = 0; i < specs.length; i += 5) {
  const res = await fetch(`${API}/library/held-out`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.API_TOKEN}`,
    },
    body: JSON.stringify({ specs: specs.slice(i, i + 5), retireAfter }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`upload refused at file ${i}: ${body.error ?? res.status}`);
  added += body.added;
}
const library = await (await fetch(`${API}/library`)).json();
console.log(`Uploaded ${added} held-out attacks to ${API}, retiring after ${retireAfter}.`);
console.log(
  `The library now: ${library.published} published, ${library.acceptedBounties} accepted bounties, ${library.heldOut.active} held out.`,
);
