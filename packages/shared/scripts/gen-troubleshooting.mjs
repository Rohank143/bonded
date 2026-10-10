// Writes docs/TROUBLESHOOTING.md from the problem list in @bondedhq/shared (run after a build:
// `pnpm docs:troubleshooting`). With --check, fails instead when the committed page differs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { troubleshootingMarkdown } from "../dist/troubleshooting-doc.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/TROUBLESHOOTING.md");
const text = troubleshootingMarkdown();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {
    // Missing counts as out of date.
  }
  if (current !== text) {
    console.error("docs/TROUBLESHOOTING.md is out of date: run pnpm docs:troubleshooting");
    process.exit(1);
  }
  console.log("docs/TROUBLESHOOTING.md is up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
