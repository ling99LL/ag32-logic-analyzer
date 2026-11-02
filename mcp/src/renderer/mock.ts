import type { Ag32DesktopApi } from "../shared/api.js";
import type {
  AppSettings,
  AppSnapshot,
  CaptureFrame,
  CaptureRequest,
  ClientRole,
  DaemonEvent,
  DeviceState,
  HistoryRecord,
  Pin11Config,
  SynchronizedCaptureGroup,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

export function createMockApi(): Ag32DesktopApi & {
  openPath(target: string, reveal?: boolean): Promise<string>;
} {
  const listeners = new Set<(event: DaemonEvent) => void>();
  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let sequence = 0;
  const history: HistoryRecord[] = [];
  const frames = new Map<string, CaptureFrame>();
  let synchronizedCapture: SynchronizedCaptureGroup | null = null;
  const firstDevice = createDevice(1, "COM33");
  const latestFrame = createFrame(4096, 20_000_000, firstDevice);
  frames.set(firstDevice.deviceId, latestFrame);
  let snapshot: AppSnapshot = {
    devices: [firstDevice],
    activeDeviceId: firstDevice.deviceId,
    device: firstDevice,
    repeat: { active: false, fps: 20, ownerRole: null, deviceId: firstDevice.deviceId },
    clients: [
      { id: "desktop-preview", role: "desktop", name: "AG32 Logic Studio" },
      { id: "mcp-preview", role: "mcp", name: "AG32 Logic Studio MCP" },
    ],
    latestCapture: latestFrame,
    latestCaptures: [latestFrame],
    synchronizedCapture: null,
    activity: [
      {
        id: "preview-1",
        at: new Date().toISOString(),
        role: "desktop",
        deviceId: firstDevice.deviceId,
        label: "连接设备",
        status: "ok",
        detail: "COM33 / GEN v1.3",
      },
    ],
    storage: {
      previewBytes: 800_000,
      persistentBytes: 12_400_000,
      totalBytes: 13_200_000,
      limitBytes: 2 * 1024 * 1024 * 1024,
      previewFrames: 1,
      persistentRecords: history.length,
    },
  };

  function emit(event: DaemonEvent): void {
    for (const listener of listeners) listener(event);
  }

  function activeDevice(): DeviceState {
    return snapshot.devices.find((device) => device.deviceId === snapshot.activeDeviceId)
      ?? snapshot.devices[0]
      ?? firstDevice;
  }

  function syncSnapshot(): void {
    snapshot = {
      ...snapshot,
      activeDeviceId: snapshot.devices.some((device) => device.deviceId === snapshot.activeDeviceId)
        ? snapshot.activeDeviceId
        : snapshot.devices[0]?.deviceId ?? null,
      device: activeDevice(),
      latestCaptures: [...frames.values()],
      latestCapture: frames.get(activeDevice().deviceId)
        ?? snapshot.latestCapture
        ?? null,
      synchronizedCapture,
    };
  }

  function createDevice(index: 1 | 2 | 3 | 4, port: string): DeviceState {
    return {
      deviceId: `usb-serial:AG32-MOCK-${index}`,
      alias: `#${index}`,
      identity: `usb-serial:AG32-MOCK-${index}`,
      identityStable: true,
      connected: true,
      port,
      connectedAt: new Date().toISOString(),
      deviceIndex: index,
      info: {
        firmware: { major: 1, minor: 3 },
        waveform: "sine",
        amplitudePercent: 80,
        requestedFrequencyHz: 100_000,
        actualFrequencyHz: 100_000,
        flags: 0,
        tableLength: 256,
        rateCapHz: 5_000_000,
        deviceIndex: index,
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
    };
  }

  function capture(
    request: CaptureRequest,
    device = activeDevice(),
    source: ClientRole = "desktop",
  ): CaptureFrame {
    const frame = createFrame(request.sampleCount, request.sampleRateHz, device, source);
    frame.pretriggerPercent = request.pretriggerPercent ?? settings.pretriggerPercent;
    frame.trigger = request.trigger ?? { mode: "immediate" };
    frame.persistent = Boolean(request.persist);
    frames.set(device.deviceId, frame);
    if (frame.persistent) {
      const record: HistoryRecord = {
        id: frame.id,
        deviceId: device.deviceId,
        deviceAlias: device.alias,
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
    syncSnapshot();
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
          syncSnapshot();
          return snapshot as T;
        case "list_devices":
          return {
            selected: activeDevice().port,
            devices: [1, 2, 3, 4].map((index) => {
              const connected = snapshot.devices.find((device) => device.deviceIndex === index);
              return {
                path: `COM${32 + index}`,
                sumpId: true,
              firmware: "v1.3",
                deviceIndex: index as 1 | 2 | 3 | 4,
                identity: `usb-serial:AG32-MOCK-${index}`,
                identityStable: true,
                friendlyName: `AG32 USB CDC #${index}`,
                connectedDeviceId: connected?.deviceId,
                connectedAlias: connected?.alias,
              };
            }),
          } as T;
        case "connect": {
          const index = Number(input.deviceIndex) as 1 | 2 | 3 | 4;
          if (![1, 2, 3, 4].includes(index)) throw new Error("设备编号必须是 1、2、3 或 4");
          const duplicate = snapshot.devices.find((device) => device.deviceIndex === index);
          if (duplicate && duplicate.port !== String(input.port)) {
            throw new Error(`设备编号 #${index} 已被使用`);
          }
          let device = snapshot.devices.find((item) => item.deviceIndex === index)
            ?? snapshot.devices.find((item) => item.port === String(input.port));
          if (!device) {
            if (snapshot.devices.length >= 4) throw new Error("最多同时连接 4 台设备");
            device = createDevice(index, String(input.port ?? `COM${32 + index}`));
            snapshot.devices.push(device);
          }
          if (input.alias) device.alias = String(input.alias);
          device.port = String(input.port ?? device.port);
          snapshot.activeDeviceId = device.deviceId;
          syncSnapshot();
          emit({ event: "device", data: device });
          emit({ event: "snapshot", data: snapshot });
          return device as T;
        }
        case "disconnect": {
          const device = resolveDevice(input.deviceId);
          snapshot.devices = snapshot.devices.filter((item) => item.deviceId !== device.deviceId);
          frames.delete(device.deviceId);
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return { connected: false, deviceId: device.deviceId } as T;
        }
        case "disconnect_all":
          snapshot.devices = [];
          frames.clear();
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return { disconnected: [] } as T;
        case "set_active_device": {
          const device = resolveDevice(input.deviceId);
          snapshot.activeDeviceId = device.deviceId;
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return device as T;
        }
        case "set_device_index": {
          const device = resolveDevice(input.deviceId);
          const index = Number(input.deviceIndex);
          if (![1, 2, 3, 4].includes(index)) throw new Error("设备编号必须是 1、2、3 或 4");
          if (snapshot.devices.some((item) =>
            item.deviceId !== device.deviceId && item.deviceIndex === index)) {
            throw new Error(`设备编号 #${index} 已被使用`);
          }
          device.deviceIndex = index as 1 | 2 | 3 | 4;
          if (device.info) device.info.deviceIndex = device.deviceIndex;
          if (device.alias.startsWith("#")) device.alias = `#${index}`;
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "get_device_info":
          return resolveDevice(input.deviceId) as T;
        case "capture":
          await wait(120);
          return capture(
            input as unknown as CaptureRequest,
            resolveDevice(input.deviceId),
          ) as T;
        case "capture_synchronized": {
          const ids = Array.isArray(input.deviceIds)
            ? input.deviceIds.map(String)
            : snapshot.devices.map((device) => device.deviceId);
          const request = input.request as CaptureRequest;
          const started = Date.now();
          const entries = ids.map((id, index) => {
            const device = resolveDevice(id);
            const hostStartAt = new Date(started + index * 6).toISOString();
            const frame = capture(request, device);
            return {
              deviceId: device.deviceId,
              alias: device.alias,
              frame,
              hostReadyAt: new Date(started).toISOString(),
              hostStartAt,
              hostCompleteAt: new Date(Date.now() + 120).toISOString(),
            };
          });
          const createdAt = new Date().toISOString();
          synchronizedCapture = {
            id: `mock-group-${Date.now()}`,
            createdAt,
            deviceIds: entries.map((entry) => entry.deviceId),
            syncMode: "software",
            hardwareSynchronized: false,
            maxStartSkewMs: 18,
            durationMs: Date.now() - started + 120,
            request,
            frames: entries,
            note: "主机并行启动并读取；严格时序比较需要公共外部触发和公共参考时钟。",
          };
          syncSnapshot();
          emit({ event: "group_capture", data: synchronizedCapture });
          emit({ event: "snapshot", data: snapshot });
          return synchronizedCapture as T;
        }
        case "get_synchronized_capture":
          return synchronizedCapture as T;
        case "start_repeat": {
          const device = resolveDevice(input.deviceId);
          const fps = Math.max(1, Math.min(30, Number(input.fps) || 20));
          snapshot.repeat = { active: true, fps, ownerRole: "desktop", deviceId: device.deviceId };
          snapshot.activeDeviceId = device.deviceId;
          if (repeatTimer) clearInterval(repeatTimer);
          repeatTimer = setInterval(() => {
            capture(input.request as CaptureRequest, device);
          }, 1000 / fps);
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return snapshot.repeat as T;
        }
        case "stop_repeat":
          if (repeatTimer) clearInterval(repeatTimer);
          repeatTimer = null;
          snapshot.repeat = { ...snapshot.repeat, active: false, ownerRole: null };
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return snapshot.repeat as T;
        case "configure_pin5_square": {
          const device = resolveDevice(input.deviceId);
          device.pin5 = {
            ...device.pin5!,
            squareSelected: true,
            done: true,
          };
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "configure_pin5_engine": {
          const device = resolveDevice(input.deviceId);
          device.pin5 = {
            ...device.pin5!,
            squareSelected: false,
            busy: true,
            done: false,
            remainingNs: Number(input.delayNs) || 0,
          };
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "pin5_engine_control": {
          const device = resolveDevice(input.deviceId);
          device.pin5 = { ...device.pin5!, busy: input.action === "arm" };
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "configure_pin11": {
          const device = resolveDevice(input.deviceId);
          const config = input as unknown as Pin11Config;
          device.info = {
            ...device.info!,
            waveform: config.waveform,
            amplitudePercent: config.amplitudePercent,
            requestedFrequencyHz: config.frequencyHz,
            actualFrequencyHz: config.frequencyHz,
            flags: config.enabled ? 1 : 0,
          };
          device.pin11Static = config.enabled ? null : 0;
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "configure_pin11_static": {
          const device = resolveDevice(input.deviceId);
          device.pin11Static = Number(input.mode) as 0 | 1 | 2;
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "safe_idle": {
          const device = resolveDevice(input.deviceId);
          device.pin11Static = 0;
          device.pin5 = { ...device.pin5!, squareSelected: false, outputHigh: false };
          syncSnapshot();
          emit({ event: "device", data: device });
          return device as T;
        }
        case "safe_idle_all": {
          for (const device of snapshot.devices) {
            device.pin11Static = 0;
            device.pin5 = { ...device.pin5!, squareSelected: false, outputHigh: false };
          }
          syncSnapshot();
          emit({ event: "snapshot", data: snapshot });
          return snapshot.devices as T;
        }
        case "history_list":
          return history as T;
        case "history_load": {
          const record = history.find((item) => item.id === input.id);
          return (record ? frames.get(record.deviceId ?? "") ?? activeFrame() : activeFrame()) as T;
        }
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
          if (input.group) return synchronizedCapture as T;
          return (frames.get(String(input.deviceId ?? activeDevice().deviceId))
            ?? (input.deviceId ? null : activeFrame())) as T;
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

  function resolveDevice(value: unknown): DeviceState {
    const id = typeof value === "string" ? value : activeDevice().deviceId;
    const device = snapshot.devices.find((item) => item.deviceId === id);
    if (!device) throw new Error(`设备 ${id} 未连接`);
    return device;
  }

  function activeFrame(): CaptureFrame {
    return frames.get(activeDevice().deviceId) ?? latestFrame;
  }

  function createFrame(
    sampleCount: number,
    sampleRateHz: number,
    device: DeviceState,
    source: ClientRole = "desktop",
  ): CaptureFrame {
    const count = Math.max(4, sampleCount);
    const samples = new Uint8Array(count);
    const phase = (device.deviceIndex ?? 1) * 3;
    const ch1Period = Math.max(4, Math.round(sampleRateHz / 125_000));
    const ch2Period = Math.max(16, Math.round(sampleRateHz / 40_000));
    const ch3Period = Math.max(8, Math.round(sampleRateHz / 500_000));
    for (let index = 0; index < count; index += 1) {
      let value = 0;
      if (Math.floor((index + phase) / (ch1Period / 2)) % 2 === 0) value |= 1;
      if ((index + phase) % ch2Period < ch2Period * 0.32) value |= 2;
      if (Math.floor((index + phase) / 3) % 2 === 0) value |= 4;
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
      deviceId: device.deviceId,
      deviceAlias: device.alias,
      createdAt: new Date().toISOString(),
      source,
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
