// Builds the docs site's pages from the Markdown already in the repo (README, docs/, the
// contracts' READMEs). Nothing under src/content/docs except index.mdx is written by hand.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_DIRS, FOLDERS, PAGES } from "./pages.mjs";
import { pageUrl, transform } from "./transform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outDir = path.resolve(here, "../src/content/docs");
const publicDir = path.resolve(here, "../public");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
const isFile = (p) => exists(p) && fs.statSync(path.join(root, p)).isFile();

function listFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? listFiles(rel) : [rel];
  });
}

// Start clean so a renamed or removed doc doesn't linger.
for (const sub of new Set(
  [...PAGES.map((p) => p.slug), ...FOLDERS.map((f) => f.slug)].map((s) => s.split("/")[0]),
)) {
  fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
}
fs.rmSync(path.join(publicDir, "evidence"), { recursive: true, force: true });

// Pages: the fixed list, then every file in the decision and progress folders.
const pages = PAGES.map((p) => ({ ...p }));
const folderPages = [];
for (const folder of FOLDERS) {
  const files = fs
    .readdirSync(path.join(root, folder.dir))
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const file of files) {
    folderPages.push({ src: `${folder.dir}/${file}`, slug: `${folder.slug}/${folder.name(file)}` });
  }
}
pages.push(...folderPages);

const targets = new Map(pages.map((p) => [p.src, pageUrl(p.slug)]));
for (const f of FOLDERS) targets.set(f.dir, pageUrl(f.slug));

const ctx = { targets, evidence: EVIDENCE_DIRS, exists: isFile };

for (const page of pages) {
  const dest = path.join(outDir, `${page.slug}.md`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, transform(read(page.src), page.src, ctx, { title: page.title }));
}

// Index pages for the folders.
for (const folder of FOLDERS) {
  const entries = folderPages
    .filter((p) => p.slug.startsWith(`${folder.slug}/`))
    .map((p) => {
      const m = read(p.src).match(/^# (.+)$/m);
      return `- [${m ? m[1].replace(/`/g, "") : p.slug}](${pageUrl(p.slug)})`;
    });
  const dest = path.join(outDir, folder.slug, "index.md");
  fs.writeFileSync(
    dest,
    [
      "---",
      `title: ${JSON.stringify(folder.index.title)}`,
      `description: ${JSON.stringify(folder.index.description)}`,
      "---",
      "",
      folder.index.intro,
      "",
      ...entries,
      "",
    ].join("\n"),
  );
}

// Evidence files the pages cite, served as they are.
for (const { from, to, only } of EVIDENCE_DIRS) {
  if (!exists(from)) continue;
  for (const file of listFiles(from)) {
    if (only && !only.test(file)) continue;
    const dest = path.join(publicDir, to, file.slice(from.length + 1));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
}

console.log(`docs: wrote ${pages.length} pages`);
