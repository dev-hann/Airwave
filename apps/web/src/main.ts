import { createApp } from "vue";
import { createPinia } from "pinia";
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

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ui);

// Start the WS bus after Pinia exists: snapshot handlers write into stores.
connectWebsocket();

app.mount("#app");
