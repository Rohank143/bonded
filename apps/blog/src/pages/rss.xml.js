import rss from "@astrojs/rss";
import { publishedPosts } from "../posts";

export async function GET(context) {
  const posts = await publishedPosts();
  const base = new URL(import.meta.env.BASE_URL, context.site);
  return rss({
    title: "Bonded blog",
    description:
      "Red-teaming AI agents, safety scores, and automatic payouts when an agent breaks its rules.",
    site: base.href,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: new URL(`${p.id}/`, base).href,
    })),
  });
}
