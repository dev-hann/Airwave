<template>
  <div>
    <h2 class="text-2xl font-bold">Update</h2>
    <p class="mt-1 text-sm text-muted">
      Manage included binaries (yt-dlp, ffmpeg, ffprobe, deno) and install updates.
    </p>

    <div v-if="loading" class="mt-6 text-sm text-muted">Loading...</div>
    <div v-else-if="errorMessage" class="mt-6 text-sm text-red-400">{{ errorMessage }}</div>

    <div v-else class="mt-6 space-y-4">
      <div class="rounded-lg border border-neutral-700 p-4 surface-panel">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="font-medium flex items-center gap-2">
              <span>Airwave app</span>
              <a
                v-if="appUpdates.releases_url"
                :href="appUpdates.releases_url"
                target="_blank"
                class="text-xs text-muted"
              >
                <UIcon name="i-bi-box-arrow-up-right" class="size-3 shrink-0" aria-hidden="true" />
              </a>
            </div>
            <div class="mt-1 text-sm text-muted">
              Installed: {{ appUpdates.current || "dev" }}
              <span v-if="appUpdates.latest"> · Latest: {{ appUpdates.latest }}</span>
            </div>
            <div v-if="appUpToDate" class="mt-1 text-xs text-muted">Up to date</div>
            <div v-else-if="appUpdates.has_update" class="mt-1 text-xs text-primary">
              Update available
            </div>
            <div v-if="appUpgrading || upgradePolling" class="mt-1 text-xs text-amber-400">
              Updating — the app restarts and this page reloads shortly.
            </div>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="appUpdates.has_update && appUpdates.can_upgrade"
              :loading="appUpgrading"
              size="sm"
              label="Update now"
              @click="appUpgradeModalOpen = true"
            />
            <span
              v-else-if="!appUpdates.can_upgrade && !appUpToDate && appUpdates.current"
              class="text-xs text-muted"
            >
              Automatic upgrade not configured (docker deployments)
            </span>
          </div>
        </div>
      </div>

      <div
        v-for="b in binaries"
        :key="b.name"
        class="rounded-lg border border-neutral-700 p-4 surface-panel"
      >
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="min-w-0">
            <div class="font-medium flex items-center gap-2">
              <span class="truncate">{{ b.name }}</span>
              <a v-if="b.link" :href="b.link" target="_blank" class="text-xs text-muted">
                <UIcon name="i-bi-box-arrow-up-right" class="size-3 shrink-0" aria-hidden="true" />
              </a>
            </div>
            <div class="mt-1 text-sm text-muted truncate" :title="b.path">{{ b.path }}</div>
            <div class="mt-1 text-xs text-muted">
              Installed: {{ b.version || "—" }}
              <span v-if="updatesById[b.name]">
                · Latest: {{ updatesById[b.name]?.latest || "—" }}
              </span>
              <span v-if="b.in_use" class="ml-1 text-amber-400">(in use)</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="b.is_system"
              variant="soft"
              color="neutral"
              size="sm"
              disabled
              label="System (read-only)"
            />
            <UButton
              v-else-if="updatesById[b.name]?.has_update"
              :loading="installing === b.name"
              size="sm"
              label="Update"
              @click="onUpdateClick(b)"
            />
            <UButton
              v-else-if="!b.version && updatesById[b.name]"
              :loading="installing === b.name"
              size="sm"
              label="Install"
              @click="onUpdateClick(b)"
            />
            <span v-else-if="b.version && !updatesById[b.name]?.has_update" class="text-xs text-muted">
              Up to date
            </span>
          </div>
        </div>
      </div>

      <div v-if="binaries.length === 0 && !loading" class="text-sm text-muted">
        No binary information available.
      </div>
    </div>

    <UModal v-model:open="confirmStopModalOpen" :ui="{ width: 'max-w-sm' }">
      <template #content>
        <div class="p-4">
          <h3 class="text-lg font-semibold">Binary in use</h3>
          <p class="mt-2 text-sm text-muted">
            {{ pendingInstallName }} is currently in use by the stream. To update, playback will be
            stopped first.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <UButton variant="ghost" color="neutral" @click="confirmStopModalOpen = false">
              Cancel
            </UButton>
            <UButton
              color="primary"
              :loading="installing === pendingInstallName"
              @click="confirmStopAndUpdate"
            >
              Stop and update
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="appUpgradeModalOpen" :ui="{ width: 'max-w-sm' }">
      <template #content>
        <div class="p-4">
          <h3 class="text-lg font-semibold">Update app</h3>
          <p class="mt-2 text-sm text-muted">
            Pulls the latest release image and restarts the app. Playback stops for a few seconds
            and this page reloads automatically.
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <UButton variant="ghost" color="neutral" @click="appUpgradeModalOpen = false">
              Cancel
            </UButton>
            <UButton color="primary" :loading="appUpgrading" @click="confirmAppUpgrade">
              Update and restart
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { fetchJson } from "../../composables/useApi";

const binaries = ref([]);
const updates = ref([]);
const loading = ref(true);
const errorMessage = ref("");
const installing = ref("");
const confirmStopModalOpen = ref(false);
const pendingInstallName = ref("");
const appUpdates = ref({});
const appUpgradeModalOpen = ref(false);
const appUpgrading = ref(false);

const appUpToDate = computed(() => {
  const a = appUpdates.value;
  return Boolean(a.current) && a.current !== "dev" && !a.has_update;
});

const updatesById = computed(() => {
  const byId = {};
  for (const u of updates.value) {
    byId[u.name] = u;
  }
  return byId;
});

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const [binRes, updRes, appRes] = await Promise.all([
      fetchJson("/api/binaries"),
      fetchJson("/api/binaries/updates"),
      fetchJson("/api/system/updates").catch(() => ({})),
    ]);
    binaries.value = binRes.binaries || [];
    updates.value = updRes.updates || [];
    appUpdates.value = appRes;
  } catch (e) {
    errorMessage.value = e?.message || "Failed to load binary status.";
  } finally {
    loading.value = false;
  }
}

function onUpdateClick(b) {
  if (b.in_use && (b.name === "ffmpeg" || b.name === "yt-dlp")) {
    pendingInstallName.value = b.name;
    confirmStopModalOpen.value = true;
  } else {
    doInstall(b.name, false);
  }
}

async function confirmStopAndUpdate() {
  if (!pendingInstallName.value) return;
  await doInstall(pendingInstallName.value, true);
  confirmStopModalOpen.value = false;
  pendingInstallName.value = "";
}

async function doInstall(name, stopStreamFirst) {
  installing.value = name;
  errorMessage.value = "";
  try {
    const response = await fetch("/api/binaries/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stop_stream_first: stopStreamFirst }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && data.detail === "binary_in_use") {
        pendingInstallName.value = name;
        confirmStopModalOpen.value = true;
        return;
      }
      throw new Error(data.detail || data.message || `Request failed: ${response.status}`);
    }
    await load();
  } catch (e) {
    errorMessage.value = e?.message || `Failed to install ${name}.`;
  } finally {
    installing.value = "";
  }
}

const upgradePolling = ref(false);
let upgradePollTimer = null;

async function confirmAppUpgrade() {
  appUpgrading.value = true;
  errorMessage.value = "";
  try {
    const response = await fetch("/api/system/upgrade", { method: "POST" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `Request failed: ${response.status}`);
    }
    appUpgradeModalOpen.value = false;
    // Update is now running server-side (202 accepted); the container will be
    // replaced. Poll the version until it changes, then reload the app.
    const versionBefore = appUpdates.value?.current || "";
    if (upgradePollTimer) clearInterval(upgradePollTimer);
    upgradePolling.value = true;
    upgradePollTimer = setInterval(async () => {
      try {
        const res = await fetch("/api/system/version");
        if (!res.ok) return; // server restarting — keep polling
        const data = await res.json().catch(() => null);
        if (data?.version && data.version !== versionBefore) {
          clearInterval(upgradePollTimer);
          upgradePollTimer = null;
          upgradePolling.value = false;
          window.location.reload();
        }
      } catch {
        /* server restarting — keep polling */
      }
    }, 3000);
  } catch (e) {
    errorMessage.value = e?.message || "App upgrade failed.";
  } finally {
    appUpgrading.value = false;
  }
}

onUnmounted(() => {
  if (upgradePollTimer) clearInterval(upgradePollTimer);
});

onMounted(load);
</script>
