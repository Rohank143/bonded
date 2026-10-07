import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, resolveHref, transform } from "./transform.mjs";

const ctx = {
  targets: new Map([
    ["docs/PLAN.md", "/docs/overview/plan/"],
    ["docs/decisions/002-mandate-vault.md", "/docs/decisions/002-mandate-vault/"],
    ["docs/decisions", "/docs/decisions/"],
  ]),
  evidence: [{ from: "docs/progress/evidence", to: "evidence" }],
  exists: (p) => p === "docs/progress/evidence/a.json",
  labels: new Map([["docs/PLAN.md", "Product and build plan"]]),
  shorts: new Map([["docs/PLAN.md", "the plan"]]),
  components: new Map([["apps/api", "the API"]]),
  leftovers: [],
};

test("a relative link to another doc points at its page and keeps the anchor", () => {
  assert.equal(
    resolveHref("PLAN.md#section-9", "docs/AGENTS.md", ctx),
    "/docs/overview/plan/#section-9",
  );
  assert.equal(resolveHref("docs/PLAN.md", "README.md", ctx), "/docs/overview/plan/");
  assert.equal(resolveHref("decisions/", "docs/AGENTS.md", ctx), "/docs/decisions/");
});

test("a GitHub link to a doc in this repo points at the page", () => {
  const url = "https://github.com/ddboy19912/bonded/blob/main/docs/PLAN.md#x";
  assert.equal(resolveHref(url, "README.md", ctx), "/docs/overview/plan/#x");
  assert.equal(
    resolveHref("https://github.com/ddboy19912/bonded/tree/main/docs/decisions", "README.md", ctx),
    "/docs/decisions/",
  );
});

test("links to the repo itself, issues and source code are dropped", () => {
  for (const href of [
    "https://github.com/ddboy19912/bonded",
    "https://github.com/ddboy19912/bonded/issues/84",
    "https://github.com/ddboy19912/bonded/blob/main/apps/api/src/main.ts",
    "../apps/api",
  ]) {
    assert.equal(resolveHref(href, "docs/AGENTS.md", ctx), null, href);
  }
});

test("other sites and evidence files are kept", () => {
  assert.equal(
    resolveHref("https://github.com/coinbase/agentkit", "README.md", ctx),
    "https://github.com/coinbase/agentkit",
  );
  assert.equal(
    resolveHref("progress/evidence/a.json", "docs/AGENTS.md", ctx),
    "/docs/evidence/a.json",
  );
  assert.equal(resolveHref("progress/evidence/missing.json", "docs/AGENTS.md", ctx), null);
});

test("transform adds front matter, drops the h1 and rewrites links outside code only", () => {
  const md = [
    "# Agents in Bonded",
    "",
    "What an agent is. See [the plan](PLAN.md) and [the code](../apps/api) and `docs/PLAN.md`.",
    "",
    "```bash",
    "git clone https://github.com/ddboy19912/bonded [x](PLAN.md)",
    "```",
    "",
    "Run `forge test` with `<chainId>` and <chainId> here.",
  ].join("\n");
  const out = transform(md, "docs/AGENTS.md", ctx);
  assert.match(out, /^---\ntitle: "Agents in Bonded"\n/);
  assert.doesNotMatch(out, /^# /m);
  assert.match(out, /\[the plan\]\(\/docs\/overview\/plan\/\)/);
  assert.match(out, /and the code and \[the plan\]\(\/docs\/overview\/plan\/\)/);
  assert.match(out, /git clone <repository-url> \[x\]\(PLAN.md\)/);
  assert.match(out, /`<chainId>` and &lt;chainId&gt; here/);
});

test("description is the first paragraph without markup", () => {
  assert.equal(
    describe(["", "# T", "", "A **bold** [link](x) claim.", "", "More."]),
    "A bold link claim.",
  );
});
