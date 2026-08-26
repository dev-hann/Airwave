# Theme System

Read this before adding or modifying themes.

## File layout

- Shared/global stylesheet: `frontend/src/css/style.css`
- Per-theme files: `frontend/src/css/themes/*.css` (currently `night.css`, `dark.css` — `dark` is the default when no preference is saved)

Each theme file is self-contained and defines:

- App shell/surface variables (`--app-*`)
- Nuxt UI tokens (`--ui-*` and `--ui-color-*`) so `UButton`, `UTabs`, and related components restyle with the theme

## State

- Managed by the ui store (`apps/web/src/stores/ui.ts`), persisted in localStorage under `airwave:settings:theme`.
- Theme selector UI lives at `apps/web/src/components/settings/GeneralSettingsPanel.vue`.

## Adding a new theme

1. Create `apps/web/src/css/themes/<theme-name>.css`
2. Import it from `apps/web/src/css/style.css`
3. Add it to `supportedThemes` in `apps/web/src/stores/ui.ts` (and the `ThemeName` type)
4. Expose it in the `/settings` theme selector
5. Run `npm run build`
