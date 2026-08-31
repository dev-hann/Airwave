import { defineStore } from "pinia";

import { getJson, postJson } from "../lib/api/http";
import { useNotificationsStore } from "./notifications";

/** Local-media browse entry — derived from the media API's dict payloads. */
export interface LocalMediaEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface LocalMediaRoot {
  name: string;
  path: string;
}

interface LocalMediaRootsResponse {
  roots?: LocalMediaRoot[];
}

interface LocalMediaBrowseResponse {
  entries?: LocalMediaEntry[];
}

interface LocalQueueMutationResult {
  type?: string;
  count?: number;
  skipped?: number;
}

/** Local-media actions (browse results live in the explorer page; stateless store). */
export const useExplorerStore = defineStore("explorer", () => {
  const notifications = useNotificationsStore();

  async function fetchLocalRoots(): Promise<LocalMediaRootsResponse> {
    return getJson<LocalMediaRootsResponse>("/api/media/local/roots");
  }

  async function browseLocalDirectory(path: string): Promise<LocalMediaBrowseResponse> {
    return getJson<LocalMediaBrowseResponse>("/api/media/local/browse", { path });
  }

  async function addLocalPath(path: string): Promise<void> {
    try {
      await postJson<LocalQueueMutationResult>("/api/queue/add-local", { path });
    } catch (error) {
      notifications.notifyError("Could not add local file", error);
    }
  }

  async function addLocalFolder(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const { recursive = true } = options;
    try {
      await postJson<LocalQueueMutationResult>("/api/queue/add-local-folder", { path, recursive });
    } catch (error) {
      notifications.notifyError("Could not queue folder", error);
    }
  }

  async function playLocalPath(path: string): Promise<void> {
    try {
      await postJson("/api/queue/play-now-local", { path });
    } catch (error) {
      notifications.notifyError("Could not play local file", error);
    }
  }

  async function playLocalFolder(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const { recursive = true } = options;
    try {
      await postJson<LocalQueueMutationResult>("/api/queue/play-now-local-folder", {
        path,
        recursive,
      });
    } catch (error) {
      notifications.notifyError("Could not play folder", error);
    }
  }

  return {
    fetchLocalRoots,
    browseLocalDirectory,
    addLocalPath,
    addLocalFolder,
    playLocalPath,
    playLocalFolder,
  };
});
