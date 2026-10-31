import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaptureStore } from "../daemon/storage.js";
import type { CaptureFrame } from "../shared/types.js";

test("capture storage persists, reloads, favorites and deletes records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ag32-storage-test-"));
  try {
    const store = new CaptureStore(directory);
    await store.init();
    const frame: CaptureFrame = {
      id: "20261031-120000-000-test",
      createdAt: "2026-10-31T04:00:00.000Z",
      source: "desktop",
      persistent: true,
      requestedSampleRateHz: 20_000_000,
      actualSampleRateHz: 20_000_000,
      divider: 4,
      sampleCount: 8,
      pretriggerPercent: 50,
      trigger: { mode: "immediate" },
      activeChannels: ["CH1"],
      channels: [],
      samplesBase64: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString("base64"),
    };
    const saved = await store.saveCapture(frame, "$timescale 1ns $end\n");
    assert.ok(saved.artifacts?.samplesPath);
    const records = await store.list();
    assert.equal(records.length, 1);
    const favorite = await store.favorite(frame.id, true);
    assert.equal(favorite.favorite, true);
    const loaded = await store.load(frame.id);
    assert.deepEqual(Buffer.from(loaded.samplesBase64, "base64"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const usage = await store.usage(0, 0);
    assert.equal(usage.persistentRecords, 1);
    assert.ok(usage.persistentBytes > 0);
    await store.delete(frame.id);
    assert.equal((await store.list()).length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
