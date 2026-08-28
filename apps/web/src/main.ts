import { createApp } from "vue";
import { createPinia } from "pinia";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { addCollection } from "@iconify/vue";
import ui from "@nuxt/ui/vue-plugin";

import biIcons from "@iconify-json/bi/icons.json";
import App from "./App.vue";
import { connectWebsocket } from "./lib/api/ws";
import { router } from "./router";
import "./css/style.css";

// Bundle Bootstrap Icons locally (no runtime fetch from Iconify API)
// See: https://github.com/nuxt/icon?tab=readme-ov-file#iconify-dataset
addCollection(biIcons);

// Read/caching for request-response GETs (search, media browse). WS-pushed
// domains (queue/history/playlists/playback) stay in Pinia — the server push
// is their invalidation mechanism, not this client.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const app = createApp(App);
app.use(createPinia());
app.use(VueQueryPlugin, { queryClient });
app.use(router);
app.use(ui);

// Start the WS bus after Pinia exists: snapshot handlers write into stores.
connectWebsocket();

app.mount("#app");
