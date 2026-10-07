import path from "node:path";

export const BASE = "/docs";
const REPO_URL = /^https?:\/\/github\.com\/ddboy19912\/bonded(?:\/|$)/;
const KNOWN_HTML = new Set([
  "br",
  "details",
  "summary",
  "sub",
  "sup",
  "kbd",
  "em",
  "strong",
  "b",
  "i",
]);

/** `README.md` -> `/docs/overview/introduction/` for every repo path that has a page. */
export function pageUrl(slug) {
  return `${BASE}/${slug}/`;
}

/**
 * Resolve a link found in `srcPath` to a site URL, or null when the target is not part of the
 * site (source code, scripts, issues): those links are dropped and only their text stays.
 *
 * `ctx.targets` maps repo paths to URLs, `ctx.evidence` maps repo directories to site
 * directories, and `ctx.exists(repoPath)` says whether a file is on disk.
 */
export function resolveHref(href, srcPath, ctx) {
  if (href.startsWith("#")) return href;

  let repoPath;
  let hash;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!REPO_URL.test(href)) return href; // someone else's site
    const url = new URL(href);
    hash = url.hash;
    const m = url.pathname.match(/^\/ddboy19912\/bonded\/(?:blob|tree)\/[^/]+\/(.*)$/);
    if (!m) return null; // the repository itself, issues, pull requests
    repoPath = m[1];
  } else {
    const [p, ...rest] = href.split("#");
    hash = rest.length ? `#${rest.join("#")}` : "";
    if (!p) return hash || null;
    const decoded = decodeURIComponent(p);
    repoPath = decoded.startsWith("/")
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(srcPath), decoded));
  }
  repoPath = repoPath.replace(/\/$/, "");

  const hit = ctx.targets.get(repoPath);
  if (hit) return hit + hash;
  for (const { from, to } of ctx.evidence) {
    if (repoPath.startsWith(`${from}/`) && ctx.exists(repoPath)) {
      return `${BASE}/${to}/${repoPath.slice(from.length + 1)}`;
    }
  }
  return null;
}

/** Wrap or escape one stretch of prose with no code or links in it. */
function escapePlaceholders(text) {
  return text.replace(/<(\/?)([A-Za-z][^<>\n]*)>/g, (all, slash, inner) => {
    const tag = inner.split(/[\s/]/)[0].toLowerCase();
    return KNOWN_HTML.has(tag) ? all : `&lt;${slash}${inner}&gt;`;
  });
}

const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`\n]+)`/g;

/** Rewrite the links on one line of prose. */
function transformLine(line, srcPath, ctx) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    out += escapePlaceholders(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const url = resolveHref(m[2], srcPath, ctx);
      out += url ? `[${m[1]}](${url})` : m[1];
    } else {
      // A bare mention of a doc, like `docs/PLAN.md`, becomes a link to its page.
      const url = ctx.targets.get(m[3].replace(/\/$/, ""));
      out += url ? `[\`${m[3]}\`](${url})` : m[0];
    }
  }
  return out + escapePlaceholders(line.slice(last));
}

/** Plain-text summary for the page description: the first paragraph, trimmed. */
export function describe(lines) {
  const para = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^([#>|!<`-]|\d+\.)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Turn one repo Markdown file into a Starlight page: front matter, rewritten links. */
export function transform(markdown, srcPath, ctx, { title } = {}) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let h1 = lines.findIndex((l) => /^# /.test(l));
  const heading = h1 >= 0 ? lines[h1].replace(/^# /, "").replace(/`/g, "").trim() : srcPath;
  if (h1 >= 0) lines.splice(h1, 1);

  let fence = null;
  const body = lines.map((line) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line;
    }
    if (fence) return line.replaceAll("https://github.com/ddboy19912/bonded", "<repository-url>");
    return transformLine(line, srcPath, ctx);
  });

  const front = [
    "---",
    `title: ${JSON.stringify(title ?? heading)}`,
    `description: ${JSON.stringify(describe(body))}`,
    "---",
    "",
  ];
  return `${front.join("\n")}${body.join("\n").replace(/^\n+/, "")}`;
}
