import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { deleteJson, postJson } from "../lib/api/http";
import { useHistoryStore } from "./history";
import { useQueueStore } from "./queue";

vi.mock("../lib/api/http", () => ({
  postJson: vi.fn().mockResolvedValue({}),
  deleteJson: vi.fn().mockResolvedValue(null),
  fetchJson: vi.fn().mockResolvedValue([]),
  getJson: vi.fn().mockResolvedValue({}),
}));

describe("queue store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(postJson).mockReset().mockResolvedValue({});
    vi.mocked(deleteJson).mockReset().mockResolvedValue(null);
  });

  it("addUrl posts to /api/queue/add with the url", async () => {
    await useQueueStore().addUrl("https://example.com");
    expect(postJson).toHaveBeenCalledWith("/api/queue/add", { url: "https://example.com" });
  });

  it("removeFromQueue issues DELETE on the item id", async () => {
    await useQueueStore().removeFromQueue(42);
    expect(deleteJson).toHaveBeenCalledWith("/api/queue/42");
  });

  it("clearQueue issues DELETE on /api/queue", async () => {
    await useQueueStore().clearQueue();
    expect(deleteJson).toHaveBeenCalledWith("/api/queue");
  });

  it("reorderQueueItem posts new_position (WS push reflects the result)", async () => {
    const store = useQueueStore();

    await store.reorderQueueItem(7, 3);

    expect(postJson).toHaveBeenCalledWith("/api/queue/7/reorder", { new_position: 3 });
  });
});

describe("history store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(deleteJson).mockReset().mockResolvedValue(null);
  });

  it("clearHistory posts to /api/history/clear (the actual route)", async () => {
    vi.mocked(postJson).mockReset().mockResolvedValue({});
    await useHistoryStore().clearHistory();
    expect(postJson).toHaveBeenCalledWith("/api/history/clear");
  });

  it("setHistory replaces rows wholesale", () => {
    const store = useHistoryStore();
    store.setHistory([{ error_message: null, finished_at: null, id: 1, provider: null, provider_item_id: null, queue_item_id: null, source_url: "a", started_at: null, status: "done", thumbnail_url: null, title: "T" }]);
    expect(store.history).toHaveLength(1);
  });
});
