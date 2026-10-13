// Checks every blog post before it ships: the front matter the site needs, and the wording rules
// for public claims (see the PR that added the blog).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/content/posts");
const posts = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    assert.ok(m, `${f}: missing front matter`);
    const fields = Object.fromEntries(
      m[1]
        .split("\n")
        .map((l) => l.match(/^(\w+):\s*(.*)$/))
        .filter(Boolean)
        .map(([, k, v]) => [k, v.replace(/^"|"$/g, "")]),
    );
    return { file: f, fields, body: m[2] };
  });

test("there is at least one post", () => {
  assert.ok(posts.length > 0);
});

for (const p of posts) {
  test(`${p.file}: front matter`, () => {
    assert.ok(p.fields.title, "title is required");
    assert.ok(p.fields.description, "description is required");
    assert.ok(
      p.fields.description.length <= 200,
      "description over 200 characters gets cut in previews",
    );
    assert.match(p.fields.date ?? "", /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
    assert.match(
      p.file,
      /^[a-z0-9-]+\.md$/,
      "file names become URLs: lowercase, digits and hyphens only",
    );
  });

  test(`${p.file}: wording rules`, () => {
    const text = `${p.fields.title}\n${p.fields.description}\n${p.body}`;
    // Bonded pays for rule breaches, never for market or trading losses.
    assert.doesNotMatch(
      text,
      /\b(cover|covers|covered|insure|insures)\s+(your\s+|all\s+)?(trading|market)\s+loss/i,
    );
    // House style: "Section 20", never the section sign.
    assert.doesNotMatch(text, /§/);
    // Links to the site use the canonical host.
    assert.doesNotMatch(text, /https?:\/\/bonded-nu\.vercel\.app|https?:\/\/bondedhq\.xyz/);
  });
}
