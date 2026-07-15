// @ts-check
import { defineConfig } from "astro/config";
import deno from "@deno/astro-adapter";
import starlight from "@astrojs/starlight";

// The adapter bakes `port` into the build: it is read from a virtual config
// module generated during the build, not from the environment at runtime.
// So 8085 is a build constant that Compose maps, not a knob an env var can
// turn. `site` is the same kind of build constant (Starlight and Pagefind
// need an absolute origin at build time); the apex is where the new stack
// serves once the operator cuts nginx over (ADR 0005).
export default defineConfig({
  site: "https://7th-ranger.com",
  output: "server",
  adapter: deno({ port: 8085 }),
  integrations: [
    starlight({
      title: "7R Handbook",
      // The handbook lives under /handbook/*: its pages are the `handbook/`
      // subtree of the `docs` collection (src/content/docs/handbook/**). The
      // site root and every non-handbook page are owned by Astro pages in
      // src/pages, which take precedence over Starlight's content routes.
      // Starlight prerenders its pages even under `output: "server"`, so the
      // handbook is static and reachable signed-out without touching the
      // member-area middleware.
      disable404Route: true,
      favicon: "/favicon.ico",
      customCss: ["./src/styles/tokens.css", "./src/styles/handbook.css"],
      // Give the handbook the site's own top nav (and the same nav in the mobile
      // menu), so it reads as part of the website rather than a separate docs
      // site. Search + sidebar are still Starlight's.
      components: {
        Header: "./src/components/HandbookHeader.astro",
        MobileMenuFooter: "./src/components/HandbookMobileMenuFooter.astro",
        ThemeProvider: "./src/components/HandbookThemeProvider.astro",
      },
      // Order follows the legacy hand-maintained TOC (the old index.md); the two
      // orphan pages (flight-models, fixed-wing-addendum, linked only inline in
      // the legacy content) are placed after their aviation parents.
      sidebar: [
        {
          label: "Handbook",
          items: [
            "handbook",
            "handbook/getting-started",
            "handbook/structure",
            "handbook/communication",
            "handbook/basic-infantry-skills",
            "handbook/medical",
            "handbook/battle-drills",
            "handbook/tactics-leadership",
            "handbook/combined-arms",
            "handbook/echo-platoon-support",
            "handbook/rotary-aviation",
            "handbook/reconnaissance",
            "handbook/armour",
            "handbook/fixed-wing-aviation",
            "handbook/fixed-wing-addendum",
            "handbook/flight-models",
            {
              label: "Procedures & Regulations",
              items: [
                "handbook/procedures-and-regulations",
                "handbook/procedures-and-regulations/procedures",
                "handbook/procedures-and-regulations/regulations",
              ],
            },
            "handbook/debrief",
            "handbook/qualifications",
          ],
        },
      ],
    }),
  ],
});
