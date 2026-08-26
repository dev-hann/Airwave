import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import Pages from "vite-plugin-pages";

// Icons: bundled via addCollection() in src/main.ts using @iconify-json/*.
// See: https://github.com/nuxt/icon?tab=readme-ov-file#iconify-dataset

const rootDir = new URL(".", import.meta.url).pathname;
const serverDist = `${rootDir}/../node-server/static-dist`;

export default defineConfig({
  root: rootDir,
  plugins: [Pages({ dirs: "src/pages", extensions: ["vue"] }), vue(), ui()],
  build: {
    outDir: serverDist,
    emptyOutDir: true,
    rollupOptions: {
      input: new URL("index.html", import.meta.url).pathname,
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "app.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
