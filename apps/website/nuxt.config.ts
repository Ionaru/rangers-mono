import { defineNuxtConfig } from "nuxt/config";
import { join } from "path";
import { workspaceRoot } from "@nx/devkit";

/**
 * Load tsconfig paths from a tsconfig file
 **/
function getMonorepoTsConfigPaths(tsConfigPath: string) {
  const tsPaths = require(tsConfigPath)?.compilerOptions?.paths as Record<
    string,
    string[]
  >;

  const alias: Record<string, string> = {};
  if (tsPaths) {
    for (const p in tsPaths) {
      alias[p.replace(/\/\*$/, "")] = join(
        workspaceRoot,
        tsPaths[p][0].replace(/\/\*$/, ""),
      );
    }
  } else {
    console.warn(
      "Root level tsconfig ",
      tsConfigPath,
      " does not contain any paths",
    );
  }

  return alias;
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  /**
   * Nuxt recommends setting custom alias from a tsconfig here,
   * instead of in tsconfig since it will override the auto generated tsconfig.
   * all aliases added here will be added to the auto generated tsconfig.
   * Other projects generated with Nx will be added to the root level tsconfig.base.json
   * which might want to be used in this project.
   *
   * https://nuxt.com/docs/guide/directory-structure/tsconfig
   **/
  alias: {
    pinia: "../../node_modules/@pinia/nuxt/node_modules/pinia/dist/pinia.mjs",
    ...getMonorepoTsConfigPaths("../../tsconfig.base.json"),
  },
  compatibilityDate: "2024-11-06",
  devtools: { enabled: true },
  build: {
    transpile: ["@fortawesome/vue-fontawesome"],
  },
  modules: ["@pinia/nuxt", "@nuxt/content", "@nuxt/ui", "@sidebase/nuxt-auth"],
  auth: {
    globalAppMiddleware: true,
    provider: {
      type: "authjs",
      defaultProvider: "discord",
    },
  },
  css: [
    "@fortawesome/fontawesome-svg-core/styles.css",
    "~/assets/css/root.css",
  ],
  content: {
    // documentDriven: true,
    // experimental: {
    //   clientDB: true,
    // },
  },
  router: {
    options: {
      scrollBehaviorType: "smooth",
    },
  },
  nitro: {
    preset: "node-server",
    output: {
      dir: "../../dist/apps/website",
    },
    // prerender: {
    //   crawlLinks: true,
    //   failOnError: true,
    //   routes: ["/handbook"],
    // },
  },
  routeRules: {
    "/": { prerender: true },
    // "/handbook": { prerender: true },
  },
  // ssr: false,
  // content: {
  //   experimental: {
  //     clientDB: true,
  //   },
  // },
});
