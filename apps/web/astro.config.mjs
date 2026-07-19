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
  // Astro's built-in checkOrigin (default-on under output:"server") rebuilds
  // url.origin from the request as Deno sees it behind nginx: plain http over
  // the loopback hop, so it 403s the https Origin on scheme alone. Our own
  // assertSameOrigin (src/lib/forms.ts) compares Origin against PUBLIC_BASE_URL
  // and is called by every mutating route, so this layer is both redundant and
  // wrong for this proxy topology.
  security: { checkOrigin: false },
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
      // Order mirrors the TOC on the introduction page (index.md): sections
      // 1-8 are the skills every Infantryman is expected to know, 9-15 are
      // leadership and specialist roles, and the unnumbered reference material
      // closes the list. The two orphan pages (fixed-wing-addendum,
      // flight-models, linked only inline) are placed after their aviation
      // parents. Section numbers live only in index.md's prose; keep the two
      // in sync when reordering.
      sidebar: [
        { slug: "handbook" },
        {
          label: "Infantry Fundamentals",
          items: [
            "handbook/getting-started",
            "handbook/structure",
            "handbook/communication",
            "handbook/basic-infantry-skills",
            "handbook/loadouts",
            "handbook/medical",
            "handbook/battle-drills",
            "handbook/formations",
          ],
        },
        {
          label: "Leadership & Specialist Roles",
          items: [
            "handbook/tactics-leadership",
            "handbook/combined-arms",
            "handbook/echo-platoon-support",
            "handbook/rotary-aviation",
            "handbook/reconnaissance",
            "handbook/armour",
            "handbook/fixed-wing-aviation",
            "handbook/fixed-wing-addendum",
            "handbook/flight-models",
          ],
        },
        {
          label: "Reference",
          items: [
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
            "handbook/faq",
          ],
        },
      ],
    }),
  ],
});
