import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import Pages from "vite-plugin-pages";

// Icons: bundled via addCollection() in src/main.ts using @iconify-json/*.
// See: https://github.com/nuxt/icon?tab=readme-ov-file#iconify-dataset

const rootDir = new URL(".", import.meta.url).pathname;
const serverDist = `${rootDir}/../node-server/static-dist`;

// App version — single source of truth is the ROOT package.json version
// (bumped with `npm version`, enforced against the git tag in CI). The
// server reads the same file (apps/node-server/src/version.ts), so a
// bundle/server mismatch always means a stale browser tab.
const appVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }
).version;

export default defineConfig({
  root: rootDir,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion ?? "dev"),
  },
  plugins: [Pages({ dirs: "src/pages", extensions: ["vue"] }), vue(), ui()],
  build: {
    outDir: serverDist,
    emptyOutDir: true,
    rollupOptions: {
      input: new URL("index.html", import.meta.url).pathname,
      output: {
        // Content-hashed filenames: a new build is a new URL, so browsers can
        // treat bundles as immutable and stale-cache reloads are impossible
        // (server pairs this with Cache-Control: immutable; the HTML shell is
        // no-store). See apps/node-server/src/app.ts static serving.
        entryFileNames: "app-[hash].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "app-[hash].css";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
