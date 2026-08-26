// Ambient types for virtual modules + JSON icon datasets.

declare module "~pages" {
  import type { RouteRecordRaw } from "vue-router";
  const routes: RouteRecordRaw[];
  export default routes;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
