// @ts-check
import { defineConfig } from "astro/config";
import deno from "@deno/astro-adapter";

// The adapter bakes `port` into the build: it is read from a virtual config
// module generated during the build, not from the environment at runtime.
// So 8085 is a build constant that Compose maps, not a knob an env var can
// turn.
export default defineConfig({
  output: "server",
  adapter: deno({ port: 8085 }),
});
