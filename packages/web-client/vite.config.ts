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
        // Enable code splitting with proper chunking
        manualChunks: {
          // Split vendor chunks for better caching
          react: ["react", "react-dom"],
          radix: [
            "@radix-ui/react-collapsible",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-hover-card",
            "@radix-ui/react-label",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-select",
            "@radix-ui/react-separator",
            "@radix-ui/react-slot",
            "@radix-ui/react-tooltip",
          ],
          // Shiki is large, split it separately for lazy loading potential
          shiki: ["shiki"],
        },
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
});

