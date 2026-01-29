import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const __dirname = new URL(".", import.meta.url).pathname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src",
  base: "/app/", // Serve from /app/ path on the proxy server
  publicDir: false, // We'll handle public assets manually
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: resolve(__dirname, "../proxy-server/public"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
      },
      output: {
        // Enable code splitting with proper chunking (Rolldown advancedChunks)
        advancedChunks: {
          groups: [
            { name: "react", test: /[\\/]react(?:-dom)?[\\/]/ },
            { name: "radix", test: /@radix-ui[\\/]/ },
            { name: "shiki", test: /[\\/]shiki[\\/]/ },
          ],
        },
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
});

