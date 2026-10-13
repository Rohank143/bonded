# Bonded blog

The blog at [bondedhq.xyz/blog](https://www.bondedhq.xyz/blog/). It's a small Astro site, built into the web app's output by `apps/web/build/include-blog.mjs`, the same way as the docs.

## Write in the browser (the editor)

The editor is at [bondedhq.xyz/blog/admin/](https://www.bondedhq.xyz/blog/admin/) ([Sveltia CMS](https://github.com/sveltia/sveltia-cms), configured in `public/admin/config.yml`). It's static: no server, no account to manage. It edits the same Markdown files through GitHub.

1. **Sign in once** with **Sign In Using Access Token**. Make a [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new) for `ddboy19912/bonded` only, with **Contents: Read and write**. The token stays in your browser. ("Sign In with GitHub" needs an OAuth server, which we don't run.)
2. **Write and save.** Saves are commits to the `content` branch, never to `main`. Images go to `public/images/`.
3. **Publish** by opening a PR from `content` to `main`. The post checks run, and the post goes live when it's merged.

On your machine, `pnpm --filter @bonded/blog dev` and then **Work with Local Repository** at http://localhost:4321/blog/admin/index.html edits the files in your checkout instead.

## Publish a post (by hand)

1. Add a Markdown file to `src/content/posts/`. The file name is the URL: `locked-isnt-safe.md` is served at `/blog/locked-isnt-safe/`.
2. Start it with this front matter:

   ```md
   ---
   title: "Sandboxed isn't safe"
   description: "One or two sentences. Shown in link previews; keep it under 200 characters."
   date: 2026-10-13
   tags: [Agent safety]
   ---
   ```

   Add `draft: true` to keep a post off the site and the feed.
3. Run `pnpm --filter @bonded/blog test`. It checks the front matter and the wording rules below.
4. Open a PR. The post goes live when it's merged and Vercel deploys.

`pnpm --filter @bonded/blog dev` previews it at http://localhost:4321/blog/.

## Wording rules for public claims

- Bonded pays for **rule breaches** (an action outside the agent's mandate), never for market or trading losses. Say "when your agent breaks its rules, the vault pays you back".
- Don't name other companies. Talk about the category ("sandboxed agent platforms").
- Every number links to its source: an Arena report, a claim, an evidence file or the README's results.
- Say when something is testnet only.
