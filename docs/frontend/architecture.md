# Frontend Architecture

How state, data flow, and playback are wired in `apps/web`. For file layout see `structure.md`; for code rules see `conventions.md`. Decision record: ADR-0004.

## Data flow

```
                    ┌──────────────────────────── app bootstrap (main.ts) ──────────────────────────┐
                    │ createApp → pinia → router → @nuxt/ui → connectWebsocket() → mount            │
                    └────────────────────────────────────────────────────────────────────────────────┘

  server                    lib/api/                        stores/                     components/pages
  ───────► WS snapshot ──► ws.ts ──onSnapshot──► sync.ts ──► queue / history /          ──► template renders
            (full state)   (parse, fan out)    (applySnapshot)  playlists / playback
  ───────► REST (fetch) ──────────────────────► http.ts ──► store actions (typed)
                                                                    │
  ◄───────────────────────────── actions POST back (optimistic + rollback on error) ◄┘
```

- **One sync mechanism**: full-state snapshots over WS (`/api/ws/events`). No delta events, no client→server WS sends. Snapshots arriving before `initializeLibraryData()` are lost by design — the initial REST refresh covers them. Don't "fix" this.
- `eventBus` no longer exists. If cross-store reactivity is needed, call the store directly (Pinia stores may use each other inside actions).

## Store map (Pinia setup stores, `src/stores/`)

| Store | Owns | Key actions | Notes |
|---|---|---|---|
| `playback` | `playbackState` (PlaybackStateContract) | `togglePause`, `skipCurrent`, `previousTrack`, `setRepeatMode`, `setShuffleEnabled`, `seekToPercent`, like/unlike, `initializePlayback` | Transport lives **with** its state. Optimistic update + rollback on failure. 1s ticker recomputes elapsed/progress from `started_at` (server-added field). `skipCurrent` previews the next queued item via the queue store. |
| `queue` | `queue` (QueueItem[]) | `addUrl`, `removeFromQueue`, `playUrl`, `clearQueue`, `reorderQueueItem`, `refreshQueue`/`refreshCore` | Reorder refreshes queue **and** history (a reorder can finish a track). |
| `history` | `history` (HistoryRow[]) | `clearHistory`, `setHistory` | Read-mostly; wholesale-replaced by snapshots. |
| `playlists` | `playlists` (Playlist[]), duplicate-modal state | CRUD, `importPlaylistUrl`, `importPlaylistIntoPlaylist`, `addUrlToPlaylist`, `addEntriesToPlaylist`, `addLocal*ToPlaylist`, reorders | All duplicate-check flows go through **one** helper: `withDuplicateCheck(url, body, toasts, errorTitle, onComplete?)` — check → modal → `add_all`/`skip_duplicates`. Never copy the pattern again. |
| `explorer` | nothing (actions only) | `fetchLocalRoots`, `browseLocalDirectory`, `addLocalPath/Folder`, `playLocalPath/Folder` | Browse *results* are page-local state (`pages/explorer.vue`), not store state. |
| `ui` | sidebar view/tab, search text, active playlist id, right sidebar, mobile view, theme | `initialize(route)` (once: theme + persisted settings + route watchers), `setTheme`, `selectPlaylist`, `onSearchSubmit` | Persists sidebar view/tab + theme to localStorage. Route ↔ state sync (search `?q`, `/playlist/:id`) lives here. |
| `notifications` | toast api instance | `notifySuccess`, `notifyError` | Initialized with `useToast()` in `App.vue` **before** any notify call. |

## Composables (instance-scoped, no global state)

- `useLocalPlayback(audioRef)` — the **only** playback path (ADR-0003): muted-prestart over `/stream/live.m3u8`, hls.js (MSE) or native HLS (iOS Safari), fatal-error recovery with media-error cooldown + backoff rejoin, foreground reconcile, gesture fallback, volume/mute persisted. Returns `{ localVolume, isMuted, setLocalVolume, toggleMuted }`; provided by `App.vue` as `localPlayback` (the one provide/inject pair).
- `useMediaSession()` — OS lock-screen/notification controls → playback store transport. Watching playback state, not owning it.
- `useBreakpoint()`, `usePlaylistSelector(playlists)` — pure helpers.

## Initialization order (App.vue)

1. `main.ts`: pinia active → `connectWebsocket()` (before mount — early snapshots may be lost, covered by REST)
2. App setup: `useLocalPlayback` (audio watchers), `useMediaSession`, `useUiStore()`, `notifications.initialize(useToast())`
3. `onMounted`: `uiStore.initialize(route)` (theme first, then persisted sidebar settings + route watchers) → `Promise.allSettled([initializeLibraryData(), playbackStore.initializePlayback()])`

## Optimistic update + rollback pattern

Transport actions flip state first, POST second, revert on failure (see `stores/playback.ts` tests for the contract). When adding a new one: capture previous value → apply → `try { await postJson(...) } catch { revert; notifyError }`. Snapshots may land mid-flight and overwrite — that's accepted (server state wins).

## Types

- Wire payloads: `types/api.ts` — strong types from `@airwave/shared/contracts` (zod); dict-returning endpoints (playlists, entries, local browse, search) are hand-derived there with the backend source named in a comment. Formalize them as backend response models eventually and the hand-written block shrinks.
- Enum values: `@airwave/shared` enums (`PlaybackMode`, `RepeatMode`) for constants; the contract's string unions for types.
