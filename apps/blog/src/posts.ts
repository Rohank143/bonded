import { getCollection } from "astro:content";

/** Published posts, newest first. Drafts are left out of every page and the feed. */
export async function publishedPosts() {
  const posts = await getCollection("posts", (p) => !p.data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const formatDate = (d: Date) =>
  d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
