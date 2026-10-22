import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const localPath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  publicDir: false,
  build: {
    outDir: localPath("./dist"),
    emptyOutDir: false,
    sourcemap: true,
    minify: true,
    // Extension service workers must not use dynamic imports.
    lib: {
      entry: localPath("./src/background.ts"),
      formats: ["es"],
      fileName: () => "background.js",
    },
    rolldownOptions: {
      output: { codeSplitting: false },
    },
  },
});
