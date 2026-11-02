import path from "node:path";
import {
  Ag32SerialDevice,
  listSerialPorts,
  probeSumpId,
  readInfoFrame,
} from "../device.js";
import {
  Ag32Session,
  CaptureAbortedError,
} from "../session.js";
import {
  MAX_SAMPLE_COUNT,
  MAX_SAMPLE_RATE_HZ,
  MIN_SAMPLE_COUNT,
  MIN_SAMPLE_RATE_HZ,
  normalizeSampleCount,
  parseInfoFrame,
  parsePin5StatusFrame,
} from "../protocol.js";
import { analyzeSamples, exportVcd, findActiveChannels } from "../analysis.js";
import type {
  ActivityItem,
  AppSettings,
  AppSnapshot,
  CaptureFrame,
  CaptureRequest,
  ChannelName,
  ClientRole,
  ClientState,
  DaemonMethod,
  DeviceListResult,
  DeviceState,
  HistoryRecord,
  Pin11Config,
  Pin5EngineConfig,
  RepeatState,
  SerialPortInfo,
  StorageUsage,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { CaptureStore } from "./storage.js";

interface ConnectedClient extends ClientState {
  send: (message: unknown) => void;
}

interface QueueJob<T = unknown> {
  sequence: number;
  priority: number;
  role: ClientRole;
  label: string;
  trackActivity: boolean;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface ActiveCapture {
  priority: number;
  abort: (() => Promise<void>) | null;
  yieldTimer: NodeJS.Timeout | null;
}

export class DaemonBroker {
  private readonly session = new Ag32Session();
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly queue: QueueJob[] = [];
  private readonly previewFrames: CaptureFrame[] = [];
  private readonly activity: ActivityItem[] = [];
  private processing = false;
  private sequence = 0;
  private repeatGeneration = 0;
  private repeatState: RepeatState = { active: false, fps: 20, ownerRole: null };
  private repeatRequest: Omit<CaptureRequest, "persist"> = {
    sampleRateHz: 20_000_000,
    sampleCount: 4096,
    pretriggerPercent: 50,
    trigger: { mode: "immediate" },
  };
  private latestCapture: CaptureFrame | null = null;
  private deviceState: DeviceState = {
    connected: false,
    port: null,
    info: null,
    pin5: null,
    pin11Static: null,
    deviceIndex: null,
  };
  private storageUsage: StorageUsage = {
    previewBytes: 0,
    persistentBytes: 0,
    totalBytes: 0,
    limitBytes: 2 * 1024 * 1024 * 1024,
    previewFrames: 0,
    persistentRecords: 0,
  };
  private activeCapture: ActiveCapture | null = null;

  constructor(
    private readonly store: CaptureStore,
    private readonly onIdleChanged?: () => void,
  ) {}

  async init(): Promise<void> {
    await this.store.init();
    await this.refreshStorageUsage();
  }

  addClient(client: ConnectedClient): void {
    this.clients.set(client.id, client);
    this.onIdleChanged?.();
    this.emitSnapshot();
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    this.emitSnapshot();
    this.onIdleChanged?.();
  }

  clientCount(): number {
    return this.clients.size;
  }

  async handle(method: DaemonMethod, params: unknown, role: ClientRole): Promise<unknown> {
    switch (method) {
      case "snapshot":
        return this.snapshot();
      case "list_devices":
        return this.withQueue(role, "扫描串口", 10, true, () => this.listDevices(params));
      case "connect":
        return this.withQueue(role, "连接设备", this.priority(role), true, () => this.connect(params));
      case "disconnect":
        return this.withQueue(role, "断开设备", this.priority(role), true, () => this.disconnect());
      case "set_device_index":
        return this.withQueue(role, "设置设备编号", this.priority(role), true, () => this.setDeviceIndex(params));
      case "get_device_info":
        return this.withQueue(role, "读取设备状态", this.priority(role), false, () => this.readDeviceState());
      case "capture":
        return this.withQueue(
          role,
          role === "mcp" ? "MCP 采集" : "采集波形",
          this.priority(role),
          true,
          () => this.captureFromRequest(role, normalizeCaptureRequest(params), role === "mcp"),
        );
      case "start_repeat":
        return this.withQueue(role, "启动重复采集", this.priority(role), true, () => this.startRepeat(role, params));
      case "stop_repeat":
        return this.withQueue(role, "停止重复采集", this.priority(role), true, () => this.stopRepeat());
      case "configure_pin5_square":
        return this.withQueue(role, "设置 PIN_5 方波", this.priority(role), true, () => this.configurePin5Square(params));
      case "configure_pin5_engine":
        return this.withQueue(role, "设置 PIN_5 引擎", this.priority(role), true, () => this.configurePin5Engine(params));
      case "pin5_engine_control":
        return this.withQueue(role, "控制 PIN_5 引擎", this.priority(role), true, () => this.controlPin5Engine(params));
      case "configure_pin11":
        return this.withQueue(role, "设置 PIN_11 输出", this.priority(role), true, () => this.configurePin11(params));
      case "configure_pin11_static":
        return this.withQueue(role, "设置 PIN_11 静态输出", this.priority(role), true, () => this.configurePin11Static(params));
      case "safe_idle":
        return this.withQueue(role, "输出安全空闲", this.priority(role), true, () => this.safeIdle());
      case "history_list":
        return this.store.list();
      case "history_load": {
        const input = asRecord(params);
        return this.store.load(String(input.id));
      }
      case "history_favorite": {
        const input = asRecord(params);
        const record = await this.store.favorite(String(input.id), Boolean(input.favorite));
        await this.refreshStorageUsage();
        return record;
      }
      case "history_delete": {
        const input = asRecord(params);
        await this.store.delete(String(input.id));
        await this.refreshStorageUsage();
        this.emitSnapshot();
        return { deleted: true as const, id: String(input.id) };
      }
      case "storage_usage":
        await this.refreshStorageUsage();
        return this.storageUsage;
      case "get_latest_capture":
        return this.latestCapture;
      case "get_settings":
        return this.store.getSettings();
      case "save_settings": {
        const settings = mergeSettings(params);
        return this.store.saveSettings(settings);
      }
      default:
        throw new Error(`Unsupported daemon method: ${method satisfies never}`);
    }
  }

  async shutdown(): Promise<void> {
    this.repeatState.active = false;
    this.repeatGeneration += 1;
    await this.activeCapture?.abort?.().catch(() => undefined);
    await this.session.disconnect().catch(() => undefined);
  }

  private async snapshot(): Promise<AppSnapshot> {
    return {
      device: this.deviceState,
      repeat: this.repeatState,
      clients: [...this.clients.values()].map(({ id, role, name }) => ({ id, role, name })),
      latestCapture: this.latestCapture,
      activity: this.activity.slice(0, 20),
      storage: this.storageUsage,
    };
  }

  private async listDevices(params: unknown): Promise<DeviceListResult> {
    const preferPort = typeof asRecordOrEmpty(params).preferPort === "string"
      ? String(asRecordOrEmpty(params).preferPort)
      : undefined;
    const rawPorts = await listSerialPorts();
    const ordered = preferPort
      ? [preferPort, ...rawPorts.filter((port) => port !== preferPort)]
      : rawPorts;
    const devices: SerialPortInfo[] = [];
    for (const port of ordered) {
      if (this.deviceState.connected && this.deviceState.port === port) {
        devices.push({
          path: port,
          sumpId: true,
          firmware: this.deviceState.info
            ? `v${this.deviceState.info.firmware.major}.${this.deviceState.info.firmware.minor}`
            : undefined,
          deviceIndex: this.deviceState.deviceIndex,
        });
        continue;
      }
      const device = await Ag32SerialDevice.open(port);
      if (!device) {
        devices.push({ path: port, error: "端口不可用或已被占用" });
        continue;
      }
      try {
        const sumpId = await probeSumpId(device);
        const info = sumpId ? await readInfoFrame(device) : undefined;
        devices.push({
          path: port,
          sumpId,
          firmware: info ? `v${info.firmware.major}.${info.firmware.minor}` : undefined,
          deviceIndex: info?.deviceIndex ?? null,
        });
      } catch (error) {
        devices.push({ path: port, error: error instanceof Error ? error.message : String(error) });
      } finally {
        await device.close().catch(() => undefined);
      }
    }
    return {
      selected: devices.find((device) => device.sumpId)?.path ?? null,
      devices,
    };
  }

  private async connect(
    params: unknown,
  ): Promise<{ connected: true; port: string; deviceIndex: 1 | 2 | 3 | 4 | null }> {
    const input = asRecord(params);
    if (typeof input.port !== "string" || input.port.length === 0) throw new Error("缺少串口名称");
    const requestedIndex = optionalDeviceIndex(input.deviceIndex);
    try {
      let info = await this.session.connect(input.port);
      if (requestedIndex !== undefined) {
        info = await this.session.setDeviceIndex(requestedIndex);
      }
      this.deviceState = {
        connected: true,
        port: input.port,
        info,
        pin5: await this.session.getPin5Status().catch(() => null),
        pin11Static: null,
        deviceIndex: info.deviceIndex,
      };
      this.emitDevice();
      return { connected: true, port: input.port, deviceIndex: info.deviceIndex };
    } catch (error) {
      await this.session.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private async disconnect(): Promise<{ connected: false }> {
    await this.stopRepeat();
    await this.session.disconnect();
    this.deviceState = {
      connected: false,
      port: null,
      info: null,
      pin5: null,
      pin11Static: null,
      deviceIndex: null,
    };
    this.emitDevice();
    return { connected: false };
  }

  private async setDeviceIndex(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const input = asRecord(params);
    const deviceIndex = optionalDeviceIndex(input.deviceIndex);
    if (deviceIndex === undefined) throw new Error("设备编号必须是 1、2、3 或 4");
    const info = await this.session.setDeviceIndex(deviceIndex);
    this.deviceState = {
      ...this.deviceState,
      info,
      deviceIndex: info.deviceIndex,
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async readDeviceState(): Promise<DeviceState> {
    if (!this.deviceState.connected) return this.deviceState;
    this.deviceState = {
      ...this.deviceState,
      info: await this.session.getInfo(),
      pin5: await this.session.getPin5Status(),
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async startRepeat(role: ClientRole, params: unknown): Promise<RepeatState> {
    this.requireConnected();
    const input = asRecord(params);
    const fps = Math.max(1, Math.min(30, Number(input.fps) || 20));
    this.repeatRequest = normalizeCaptureRequest(input.request);
    this.repeatState = { active: true, fps, ownerRole: role };
    this.repeatGeneration += 1;
    const generation = this.repeatGeneration;
    void this.runRepeatLoop(generation);
    this.emitSnapshot();
    return this.repeatState;
  }

  private async stopRepeat(): Promise<RepeatState> {
    this.repeatState = { ...this.repeatState, active: false, ownerRole: null };
    this.repeatGeneration += 1;
    this.requestCaptureYield(0);
    this.emitSnapshot();
    return this.repeatState;
  }

  private async runRepeatLoop(generation: number): Promise<void> {
    while (this.repeatState.active && generation === this.repeatGeneration) {
      const started = Date.now();
      try {
        const frame = await this.withQueue(
          this.repeatState.ownerRole ?? "desktop",
          "预览采集",
          30,
          false,
          () => this.captureFromRequest(this.repeatState.ownerRole ?? "desktop", this.repeatRequest, false),
        );
        void frame;
      } catch (error) {
        if (!(error instanceof CaptureAbortedError)) {
          this.pushActivity({
            role: this.repeatState.ownerRole ?? "desktop",
            label: "重复采集失败",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const interval = 1000 / Math.max(1, this.repeatState.fps);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, interval - (Date.now() - started))));
    }
  }

  private async captureFromRequest(
    role: ClientRole,
    request: CaptureRequest,
    forcePersistent: boolean,
  ): Promise<CaptureFrame> {
    this.requireConnected();
    const capturePriority = this.currentJobPriority ?? this.priority(role);
    const active: ActiveCapture = { priority: capturePriority, abort: null, yieldTimer: null };
    const result = await this.session.capture(
      {
        sampleRateHz: request.sampleRateHz,
        sampleCount: request.sampleCount,
        pretriggerPercent: request.pretriggerPercent,
        trigger: request.trigger,
      },
      {
        registerAbort: (abort) => {
          active.abort = abort;
          this.activeCapture = active;
          const queuedPriority = this.queue[0]?.priority;
          if (queuedPriority !== undefined) this.requestCaptureYield(queuedPriority);
        },
      },
    ).finally(() => {
      if (this.activeCapture === active) this.activeCapture = null;
      if (active.yieldTimer) clearTimeout(active.yieldTimer);
    });

    const measurements = analyzeSamples(result.samples, result.actualSampleRateHz) as CaptureFrame["channels"];
    const activeChannels = findActiveChannels(measurements) as ChannelName[];
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
    let frame: CaptureFrame = {
      id,
      createdAt,
      source: role,
      persistent: forcePersistent || Boolean(request.persist),
      requestedSampleRateHz: request.sampleRateHz,
      actualSampleRateHz: result.actualSampleRateHz,
      divider: result.divider,
      sampleCount: result.sampleCount,
      pretriggerPercent: result.pretriggerPercent,
      trigger: request.trigger ?? { mode: "immediate" },
      activeChannels,
      channels: measurements,
      samplesBase64: result.samples.toString("base64"),
    };

    if (frame.persistent) {
      const vcd = exportVcd(result.samples, result.actualSampleRateHz);
      frame = await this.store.saveCapture(frame, vcd);
      await this.refreshStorageUsage();
    } else {
      this.previewFrames.push(frame);
      while (this.previewFrames.length > 100) this.previewFrames.shift();
      const previewBytes = this.previewFrames.reduce(
        (total, item) => total + Buffer.byteLength(item.samplesBase64, "base64"),
        0,
      );
      this.storageUsage = {
        ...this.storageUsage,
        previewBytes,
        previewFrames: this.previewFrames.length,
        totalBytes: previewBytes + this.storageUsage.persistentBytes,
      };
    }
    this.latestCapture = frame;
    this.broadcast({ event: "capture", data: frame });
    if (frame.persistent) this.emitSnapshot();
    return frame;
  }

  private async configurePin5Square(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const input = asRecord(params);
    const frequencyHz = Math.round(Number(input.frequencyHz));
    if (!Number.isFinite(frequencyHz) || frequencyHz < 1 || frequencyHz > 100_000_000) {
      throw new Error("PIN_5 方波频率必须在 1 Hz 至 100 MHz");
    }
    this.deviceState = {
      ...this.deviceState,
      pin5: await this.session.configurePin5SquareWave(frequencyHz),
      info: await this.session.getInfo(),
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async configurePin5Engine(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const config = normalizePin5Engine(params);
    this.deviceState = {
      ...this.deviceState,
      pin5: await this.session.configurePin5Engine(config),
      info: await this.session.getInfo(),
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async controlPin5Engine(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const input = asRecord(params);
    const action = String(input.action) as "arm" | "fire" | "reset";
    if (!["arm", "fire", "reset"].includes(action)) throw new Error("PIN_5 控制动作无效");
    this.deviceState = {
      ...this.deviceState,
      pin5: await this.session.pin5EngineControl(action),
      info: await this.session.getInfo(),
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async configurePin11(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const input = asRecord(params);
    const config: Pin11Config = {
      waveform: String(input.waveform) as Pin11Config["waveform"],
      frequencyHz: Math.round(Number(input.frequencyHz)),
      amplitudePercent: Math.round(Number(input.amplitudePercent)),
      enabled: Boolean(input.enabled),
      rateCapHz: input.rateCapHz === undefined ? undefined : Math.round(Number(input.rateCapHz)),
    };
    if (!["sine", "square", "sawtooth", "triangle"].includes(config.waveform)) {
      throw new Error("PIN_11 波形类型无效");
    }
    if (!Number.isFinite(config.frequencyHz) || config.frequencyHz < 1 || config.frequencyHz > 100_000_000) {
      throw new Error("PIN_11 频率必须在 1 Hz 至 100 MHz");
    }
    if (!Number.isFinite(config.amplitudePercent) || config.amplitudePercent < 1 || config.amplitudePercent > 100) {
      throw new Error("PIN_11 幅度必须在 1% 至 100%");
    }
    if (config.rateCapHz !== undefined && (!Number.isFinite(config.rateCapHz) || config.rateCapHz < 1526)) {
      throw new Error("PIN_11 采样率上限无效");
    }
    const info = await this.session.configurePin11(config);
    this.deviceState = { ...this.deviceState, info, pin11Static: config.enabled ? null : 0 };
    this.emitDevice();
    return this.deviceState;
  }

  private async configurePin11Static(params: unknown): Promise<DeviceState> {
    this.requireConnected();
    const input = asRecord(params);
    const mode = Number(input.mode);
    if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error("PIN_11 静态输出模式必须是 0、1 或 2");
    await this.session.configurePin11Static(mode);
    this.deviceState = {
      ...this.deviceState,
      info: await this.session.getInfo(),
      pin11Static: mode,
    };
    this.emitDevice();
    return this.deviceState;
  }

  private async safeIdle(): Promise<DeviceState> {
    this.requireConnected();
    const result = await this.session.safeIdle();
    this.deviceState = {
      ...this.deviceState,
      info: result.info,
      pin5: result.pin5,
      pin11Static: 0,
    };
    this.emitDevice();
    return this.deviceState;
  }

  private requireConnected(): void {
    if (!this.deviceState.connected) throw new Error("设备尚未连接");
  }

  private async refreshStorageUsage(): Promise<void> {
    const previewBytes = this.previewFrames.reduce(
      (total, frame) => total + Buffer.byteLength(frame.samplesBase64, "base64"),
      0,
    );
    this.storageUsage = await this.store.usage(previewBytes, this.previewFrames.length);
  }

  private broadcast(event: unknown): void {
    for (const client of this.clients.values()) client.send(event);
  }

  private emitSnapshot(): void {
    void this.snapshot().then((data) => this.broadcast({ event: "snapshot", data }));
  }

  private emitDevice(): void {
    this.broadcast({ event: "device", data: this.deviceState });
    this.emitSnapshot();
  }

  private pushActivity(input: Omit<ActivityItem, "id" | "at">): ActivityItem {
    const item: ActivityItem = {
      ...input,
      id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
    };
    this.activity.unshift(item);
    if (this.activity.length > 40) this.activity.pop();
    this.broadcast({ event: "activity", data: item });
    return item;
  }

  private updateActivity(id: string, status: ActivityItem["status"], detail?: string): void {
    const item = this.activity.find((entry) => entry.id === id);
    if (!item) return;
    item.status = status;
    item.detail = detail;
    this.broadcast({ event: "activity", data: item });
  }

  private priority(role: ClientRole): number {
    return role === "mcp" ? 10 : 20;
  }

  private currentJobPriority: number | null = null;

  private withQueue<T>(
    role: ClientRole,
    label: string,
    priority: number,
    trackActivity: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    this.requestCaptureYield(priority);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        sequence: this.sequence++,
        priority,
        role,
        label,
        trackActivity,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      void this.runQueue();
    });
  }

  private async runQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.currentJobPriority = job.priority;
      const activity = job.trackActivity
        ? this.pushActivity({ role: job.role, label: job.label, status: "running" })
        : null;
      try {
        const result = await job.run();
        if (activity) this.updateActivity(activity.id, "ok");
        job.resolve(result);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (activity) this.updateActivity(activity.id, "error", failure.message);
        job.reject(failure);
      } finally {
        this.currentJobPriority = null;
      }
    }
    this.processing = false;
  }

  private requestCaptureYield(incomingPriority: number): void {
    const active = this.activeCapture;
    if (!active || !active.abort || active.priority <= incomingPriority || active.yieldTimer) return;
    active.yieldTimer = setTimeout(() => {
      if (this.activeCapture === active) void active.abort?.().catch(() => undefined);
    }, 200);
  }
}

function normalizeCaptureRequest(value: unknown): CaptureRequest {
  const input = asRecord(value);
  const sampleRateHz = Number(input.sampleRateHz);
  const requestedCount = Number(input.sampleCount);
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < MIN_SAMPLE_RATE_HZ || sampleRateHz > MAX_SAMPLE_RATE_HZ) {
    throw new Error(`采样率必须在 ${MIN_SAMPLE_RATE_HZ} 至 ${MAX_SAMPLE_RATE_HZ} Hz`);
  }
  if (!Number.isFinite(requestedCount)) {
    throw new Error("采样点数无效");
  }
  if (requestedCount < MIN_SAMPLE_COUNT || requestedCount > MAX_SAMPLE_COUNT) {
    throw new Error("采样点数必须在 4 至 8192");
  }
  const sampleCount = normalizeSampleCount(requestedCount);
  const trigger = input.trigger === undefined
    ? { mode: "immediate" as const }
    : input.trigger as CaptureRequest["trigger"];
  return {
    sampleRateHz,
    sampleCount,
    pretriggerPercent: Math.max(0, Math.min(99, Number(input.pretriggerPercent) || 0)),
    trigger,
    persist: Boolean(input.persist),
  };
}

function normalizePin5Engine(value: unknown): Pin5EngineConfig {
  const input = asRecord(value);
  const mode = String(input.mode) as Pin5EngineConfig["mode"];
  if (!["delayed_level", "delayed_pulse", "host_level", "host_pulse"].includes(mode)) {
    throw new Error("PIN_5 触发模式无效");
  }
  const action = input.action === undefined ? undefined : String(input.action) as Pin5EngineConfig["action"];
  if (action && !["arm", "fire", "reset"].includes(action)) throw new Error("PIN_5 控制动作无效");
  return {
    mode,
    activeLevel: input.activeLevel === "low" ? "low" : "high",
    idleLevel: input.idleLevel === "high" ? "high" : "low",
    delayNs: Math.max(0, Number(input.delayNs) || 0),
    widthNs: Math.max(0, Number(input.widthNs) || 0),
    action,
  };
}

function optionalDeviceIndex(value: unknown): 0 | 1 | 2 | 3 | 4 | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 4) {
    throw new Error("设备编号必须是 0、1、2、3 或 4");
  }
  return index as 0 | 1 | 2 | 3 | 4;
}

function mergeSettings(value: unknown): AppSettings {
  const input = asRecordOrEmpty(value);
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    pin5Engine: { ...DEFAULT_SETTINGS.pin5Engine, ...asRecordOrEmpty(input.pin5Engine) },
    pin11: { ...DEFAULT_SETTINGS.pin11, ...asRecordOrEmpty(input.pin11) },
    channelVisibility: {
      ...DEFAULT_SETTINGS.channelVisibility,
      ...asRecordOrEmpty(input.channelVisibility),
    },
  } as AppSettings;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数必须是对象");
  return value as Record<string, unknown>;
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
