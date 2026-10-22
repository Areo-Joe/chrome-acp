import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const localPath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: localPath("./src"),
  base: "./",
  publicDir: false,
  resolve: {
    alias: { "@": localPath("./src") },
  },
  build: {
    outDir: localPath("./dist"),
    // build.mjs cleans once before building pages and the background worker.
    emptyOutDir: false,
    sourcemap: true,
    rolldownOptions: {
      input: {
        index: localPath("./src/index.html"),
        sidepanel: localPath("./src/sidepanel.html"),
      },
    },
  },
});
