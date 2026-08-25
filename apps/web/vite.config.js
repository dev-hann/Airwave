import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import Pages from "vite-plugin-pages";
import { resolve } from "path";

// Icons: bundled via addCollection() in src/main.js using @iconify-json/*.
// See: https://github.com/nuxt/icon?tab=readme-ov-file#iconify-dataset

const serverDist = resolve(__dirname, "../server/app/static/dist");

export default defineConfig({
  root: __dirname,
  plugins: [Pages({ dirs: "src/pages", extensions: ["vue"] }), vue(), ui()],
  build: {
    outDir: serverDist,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
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
