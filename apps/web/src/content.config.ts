import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

/**
 * The Starlight `docs` collection backs the handbook. Pages live under
 * `src/content/docs/handbook/**` and render at `/handbook/*`.
 *
 * The files stay `.md` (never `.mdx`): the migrated handbook embeds raw
 * `<img style="…">` tags and bare `<br>`, which Astro Markdown passes through
 * untouched but MDX would reject (ARCHITECTURE §4.1).
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
