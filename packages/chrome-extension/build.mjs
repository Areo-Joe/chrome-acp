import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const watch = process.argv.includes("--watch");
await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });

for (const config of ["vite.config.ts", "vite.background.config.ts"]) {
  await build({
    configFile: fileURLToPath(new URL(config, import.meta.url)),
    build: { watch: watch ? {} : null },
  });
}
