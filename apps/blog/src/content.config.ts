import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/posts" }),
    schema: z.object({
      title: z.string(),
      // Shown in link previews and the post list; platforms cut longer text.
      description: z.string().max(200),
      date: z.coerce.date(),
      author: z.string().default("Fortune Ogunsusi"),
      tags: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    }),
  }),
};
