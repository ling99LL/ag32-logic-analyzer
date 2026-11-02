import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppSettings,
  CaptureFrame,
  HistoryRecord,
  StorageUsage,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

const HISTORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export class CaptureStore {
  readonly capturesDir: string;
  readonly settingsPath: string;

  constructor(readonly dataDir: string) {
    this.capturesDir = path.join(dataDir, "captures");
    this.settingsPath = path.join(dataDir, "settings.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.capturesDir, { recursive: true });
  }

  async getSettings(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) as Partial<AppSettings> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }

  async saveCapture(frame: CaptureFrame, vcd: string): Promise<CaptureFrame> {
    const directory = path.join(this.capturesDir, frame.id);
    await fs.mkdir(directory, { recursive: true });
    const samplesPath = path.join(directory, "samples.bin");
    const vcdPath = path.join(directory, "capture.vcd");
    const manifestPath = path.join(directory, "manifest.json");
    const samples = Buffer.from(frame.samplesBase64, "base64");
    const { samplesBase64: _ignored, ...manifestFrame } = frame;
    await Promise.all([
      fs.writeFile(samplesPath, samples),
      fs.writeFile(vcdPath, vcd, "utf8"),
      fs.writeFile(manifestPath, `${JSON.stringify(manifestFrame, null, 2)}\n`, "utf8"),
    ]);
    await this.pruneToLimit();
    return {
      ...frame,
      artifacts: { directory, manifestPath, samplesPath, vcdPath },
    };
  }

  async list(previewBytes = 0, previewFrames = 0): Promise<HistoryRecord[]> {
    const entries = await fs.readdir(this.capturesDir, { withFileTypes: true }).catch(() => []);
    const records: HistoryRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.capturesDir, entry.name);
      try {
        const manifestPath = path.join(directory, "manifest.json");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Omit<CaptureFrame, "samplesBase64">;
        const favorite = await pathExists(path.join(directory, "favorite.flag"));
        records.push({
          id: manifest.id,
          deviceId: manifest.deviceId,
          deviceAlias: manifest.deviceAlias,
          createdAt: manifest.createdAt,
          source: manifest.source,
          sampleRateHz: manifest.actualSampleRateHz,
          sampleCount: manifest.sampleCount,
          favorite,
          sizeBytes: await directorySize(directory),
          directory,
          manifestPath,
          samplesPath: path.join(directory, "samples.bin"),
          vcdPath: path.join(directory, "capture.vcd"),
          trigger: manifest.trigger,
          channels: manifest.channels,
        });
      } catch {
        // Ignore incomplete captures left by an interrupted write.
      }
    }
    void previewBytes;
    void previewFrames;
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async favorite(id: string, favorite: boolean): Promise<HistoryRecord> {
    const directory = this.safeCaptureDirectory(id);
    const flag = path.join(directory, "favorite.flag");
    if (favorite) await fs.writeFile(flag, "", "utf8");
    else await fs.rm(flag, { force: true });
    const record = (await this.list()).find((item) => item.id === id);
    if (!record) throw new Error(`Capture record not found: ${id}`);
    return record;
  }

  async delete(id: string): Promise<void> {
    const directory = this.safeCaptureDirectory(id);
    await fs.rm(directory, { recursive: true, force: true });
  }

  async usage(previewBytes: number, previewFrames: number): Promise<StorageUsage> {
    const records = await this.list();
    const persistentBytes = records.reduce((sum, item) => sum + item.sizeBytes, 0);
    return {
      previewBytes,
      persistentBytes,
      totalBytes: previewBytes + persistentBytes,
      limitBytes: HISTORY_LIMIT_BYTES,
      previewFrames,
      persistentRecords: records.length,
    };
  }

  async readSampleFile(id: string): Promise<Buffer> {
    return fs.readFile(path.join(this.safeCaptureDirectory(id), "samples.bin"));
  }

  async load(id: string): Promise<CaptureFrame> {
    const directory = this.safeCaptureDirectory(id);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Omit<CaptureFrame, "samplesBase64" | "artifacts">;
    const samples = await fs.readFile(path.join(directory, "samples.bin"));
    return {
      ...manifest,
      samplesBase64: samples.toString("base64"),
      artifacts: {
        directory,
        manifestPath,
        samplesPath: path.join(directory, "samples.bin"),
        vcdPath: path.join(directory, "capture.vcd"),
      },
    };
  }

  private async pruneToLimit(): Promise<void> {
    let records = await this.list();
    let total = records.reduce((sum, item) => sum + item.sizeBytes, 0);
    for (let index = records.length - 1; index >= 0 && total > HISTORY_LIMIT_BYTES; index -= 1) {
      const record = records[index];
      if (record.favorite) continue;
      await fs.rm(record.directory, { recursive: true, force: true });
      total -= record.sizeBytes;
      records = records.filter((item) => item.id !== record.id);
    }
  }

  private safeCaptureDirectory(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid capture id: ${id}`);
    return path.join(this.capturesDir, id);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}
