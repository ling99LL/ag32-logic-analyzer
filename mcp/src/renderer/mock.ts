import type { Ag32DesktopApi } from "../shared/api.js";
import type {
  AppSettings,
  AppSnapshot,
  CaptureFrame,
  CaptureRequest,
  DaemonEvent,
  HistoryRecord,
  Pin11Config,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

export function createMockApi(): Ag32DesktopApi & {
  openPath(target: string, reveal?: boolean): Promise<string>;
} {
  const listeners = new Set<(event: DaemonEvent) => void>();
  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let sequence = 0;
  let currentFrame = createFrame(4096, 20_000_000);
  const history: HistoryRecord[] = [];
  let snapshot: AppSnapshot = {
    device: {
      connected: true,
      port: "COM33",
      deviceIndex: 1,
      info: {
        firmware: { major: 1, minor: 2 },
        waveform: "sine",
        amplitudePercent: 80,
        requestedFrequencyHz: 100_000,
        actualFrequencyHz: 100_000,
        flags: 0,
        tableLength: 256,
        rateCapHz: 5_000_000,
        deviceIndex: 1,
      },
      pin5: {
        busy: false,
        done: true,
        outputHigh: false,
        remainingTicks: 0,
        config: 0x100,
        squareSelected: true,
        tickNs: 10,
        remainingNs: 0,
      },
      pin11Static: 0,
    },
    repeat: { active: false, fps: 20, ownerRole: null },
    clients: [
      { id: "desktop-preview", role: "desktop", name: "AG32 Logic Studio" },
      { id: "mcp-preview", role: "mcp", name: "AG32 Logic Studio MCP" },
    ],
    latestCapture: currentFrame,
    activity: [
      {
        id: "preview-1",
        at: new Date().toISOString(),
        role: "desktop",
        label: "连接设备",
        status: "ok",
        detail: "COM33 / GEN v1.2",
      },
    ],
    storage: {
      previewBytes: 800_000,
      persistentBytes: 12_400_000,
      totalBytes: 13_200_000,
      limitBytes: 2 * 1024 * 1024 * 1024,
      previewFrames: 100,
      persistentRecords: history.length,
    },
  };

  function emit(event: DaemonEvent): void {
    for (const listener of listeners) listener(event);
  }

  function capture(request: CaptureRequest): CaptureFrame {
    const frame = createFrame(request.sampleCount, request.sampleRateHz);
    frame.pretriggerPercent = request.pretriggerPercent ?? settings.pretriggerPercent;
    frame.trigger = request.trigger ?? { mode: "immediate" };
    frame.persistent = Boolean(request.persist);
    currentFrame = frame;
    snapshot = { ...snapshot, latestCapture: frame };
    if (frame.persistent) {
      const record: HistoryRecord = {
        id: frame.id,
        createdAt: frame.createdAt,
        source: frame.source,
        sampleRateHz: frame.actualSampleRateHz,
        sampleCount: frame.sampleCount,
        favorite: false,
        sizeBytes: 35_000 + frame.sampleCount * 2,
        directory: `C:\\AG32 Logic Studio\\captures\\${frame.id}`,
        manifestPath: `C:\\AG32 Logic Studio\\captures\\${frame.id}\\manifest.json`,
        samplesPath: `C:\\AG32 Logic Studio\\captures\\${frame.id}\\samples.bin`,
        vcdPath: `C:\\AG32 Logic Studio\\captures\\${frame.id}\\capture.vcd`,
        trigger: frame.trigger,
        channels: frame.channels,
      };
      history.unshift(record);
      snapshot.storage.persistentRecords = history.length;
      snapshot.storage.persistentBytes += record.sizeBytes;
      snapshot.storage.totalBytes =
        snapshot.storage.previewBytes + snapshot.storage.persistentBytes;
    }
    emit({ event: "capture", data: frame });
    emit({ event: "snapshot", data: snapshot });
    return frame;
  }

  return {
    platform: "win32",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async invoke<T = unknown>(method: string, params?: unknown): Promise<T> {
      const input = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "snapshot":
          return snapshot as T;
        case "list_devices":
          return {
            selected: "COM33",
            devices: [
              { path: "COM33", sumpId: true, firmware: "v1.2", deviceIndex: 1, friendlyName: "AG32 USB CDC" },
              { path: "COM26", sumpId: false, error: "无 SUMP 响应" },
            ],
          } as T;
        case "connect":
          snapshot.device.connected = true;
          snapshot.device.port = String(input.port ?? "COM33");
          snapshot.device.deviceIndex = Number(input.deviceIndex) as 1 | 2 | 3 | 4;
          if (snapshot.device.info) snapshot.device.info.deviceIndex = snapshot.device.deviceIndex;
          emit({ event: "snapshot", data: snapshot });
          return { connected: true, port: snapshot.device.port, deviceIndex: snapshot.device.deviceIndex } as T;
        case "disconnect":
          snapshot.device.connected = false;
          snapshot.device.deviceIndex = null;
          if (snapshot.device.info) snapshot.device.info.deviceIndex = null;
          emit({ event: "snapshot", data: snapshot });
          return { connected: false } as T;
        case "set_device_index": {
          const index = Number(input.deviceIndex);
          if (![1, 2, 3, 4].includes(index)) throw new Error("设备编号必须是 1、2、3 或 4");
          snapshot.device.deviceIndex = index as 1 | 2 | 3 | 4;
          if (snapshot.device.info) snapshot.device.info.deviceIndex = snapshot.device.deviceIndex;
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        }
        case "get_device_info":
          return snapshot.device as T;
        case "capture":
          await wait(120);
          return capture(input as unknown as CaptureRequest) as T;
        case "start_repeat": {
          const fps = Math.max(1, Math.min(30, Number(input.fps) || 20));
          snapshot.repeat = { active: true, fps, ownerRole: "desktop" };
          if (repeatTimer) clearInterval(repeatTimer);
          repeatTimer = setInterval(() => {
            capture({ ...(input.request as CaptureRequest), persist: false, source: "desktop" } as CaptureRequest);
          }, 1000 / fps);
          emit({ event: "snapshot", data: snapshot });
          return snapshot.repeat as T;
        }
        case "stop_repeat":
          if (repeatTimer) clearInterval(repeatTimer);
          repeatTimer = null;
          snapshot.repeat = { ...snapshot.repeat, active: false, ownerRole: null };
          emit({ event: "snapshot", data: snapshot });
          return snapshot.repeat as T;
        case "configure_pin5_square":
          snapshot.device.pin5 = {
            ...snapshot.device.pin5!,
            squareSelected: true,
            done: true,
          };
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        case "configure_pin5_engine":
          snapshot.device.pin5 = {
            ...snapshot.device.pin5!,
            squareSelected: false,
            busy: true,
            done: false,
            remainingNs: Number(input.delayNs) || 0,
          };
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        case "configure_pin11": {
          const config = input as unknown as Pin11Config;
          snapshot.device.info = {
            ...snapshot.device.info!,
            waveform: config.waveform,
            amplitudePercent: config.amplitudePercent,
            requestedFrequencyHz: config.frequencyHz,
            actualFrequencyHz: config.frequencyHz,
            flags: config.enabled ? 1 : 0,
          };
          snapshot.device.pin11Static = config.enabled ? null : 0;
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        }
        case "configure_pin11_static":
          snapshot.device.pin11Static = Number(input.mode) as 0 | 1 | 2;
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        case "safe_idle":
          snapshot.device.pin11Static = 0;
          snapshot.device.pin5 = { ...snapshot.device.pin5!, squareSelected: false, outputHigh: false };
          emit({ event: "device", data: snapshot.device });
          return snapshot.device as T;
        case "history_list":
          return history as T;
        case "history_load":
          return currentFrame as T;
        case "history_favorite": {
          const record = history.find((item) => item.id === input.id);
          if (record) record.favorite = Boolean(input.favorite);
          return record as T;
        }
        case "history_delete": {
          const index = history.findIndex((item) => item.id === input.id);
          if (index >= 0) history.splice(index, 1);
          return { deleted: true, id: input.id } as T;
        }
        case "storage_usage":
          return snapshot.storage as T;
        case "get_latest_capture":
          return currentFrame as T;
        case "get_settings":
          return settings as T;
        case "save_settings":
          settings = input as unknown as AppSettings;
          return settings as T;
        default:
          throw new Error(`Mock daemon method not implemented: ${method}`);
      }
    },
    async openPath() {
      return "";
    },
  };

  function createFrame(sampleCount: number, sampleRateHz: number): CaptureFrame {
    const count = Math.max(4, sampleCount);
    const samples = new Uint8Array(count);
    const ch1Period = Math.max(4, Math.round(sampleRateHz / 125_000));
    const ch2Period = Math.max(16, Math.round(sampleRateHz / 40_000));
    const ch3Period = Math.max(8, Math.round(sampleRateHz / 500_000));
    for (let index = 0; index < count; index += 1) {
      let value = 0;
      if (Math.floor(index / (ch1Period / 2)) % 2 === 0) value |= 1;
      if (index % ch2Period < ch2Period * 0.32) value |= 2;
      if (Math.floor(index / 3) % 2 === 0) value |= 4;
      if (index > count * 0.42 && index < count * 0.55) value |= 8;
      samples[index] = value;
    }
    const channels = [0, 1, 2, 3].map((bit) => {
      let highCount = 0;
      let edgeCount = 0;
      let firstEdgeIndex: number | null = null;
      let lastEdgeIndex: number | null = null;
      let previous = samples[0] & (1 << bit) ? 1 : 0;
      if (previous) highCount += 1;
      for (let index = 1; index < samples.length; index += 1) {
        const current = samples[index] & (1 << bit) ? 1 : 0;
        if (current) highCount += 1;
        if (current !== previous) {
          if (firstEdgeIndex === null) firstEdgeIndex = index;
          lastEdgeIndex = index;
          edgeCount += 1;
        }
        previous = current;
      }
      const frequency = edgeCount >= 2 ? (edgeCount / 2 / count) * sampleRateHz : null;
      return {
        channel: (["CH1", "CH2", "CH3", "CH4"] as const)[bit],
        pin: `PIN_${7 + bit}`,
        bit,
        highCount,
        lowCount: count - highCount,
        edgeCount,
        firstEdgeIndex,
        lastEdgeIndex,
        firstEdgeTimeNs: firstEdgeIndex === null ? null : (firstEdgeIndex / sampleRateHz) * 1e9,
        lastEdgeTimeNs: lastEdgeIndex === null ? null : (lastEdgeIndex / sampleRateHz) * 1e9,
        estimatedFrequencyHz: frequency,
      };
    });
    sequence += 1;
    return {
      id: `mock-${Date.now()}-${sequence}`,
      createdAt: new Date().toISOString(),
      source: "desktop",
      persistent: false,
      requestedSampleRateHz: sampleRateHz,
      actualSampleRateHz: sampleRateHz,
      divider: Math.max(0, Math.floor(100_000_000 / sampleRateHz) - 1),
      sampleCount: count,
      pretriggerPercent: 50,
      trigger: { mode: "immediate" },
      activeChannels: ["CH1", "CH2", "CH3", "CH4"],
      channels,
      samplesBase64: bytesToBase64(samples),
    };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
