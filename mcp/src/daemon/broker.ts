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
  SynchronizedCaptureEntry,
  SynchronizedCaptureGroup,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { CaptureStore } from "./storage.js";

const MAX_DEVICES = 4;
const DEFAULT_REPEAT_REQUEST: Omit<CaptureRequest, "persist"> = {
  sampleRateHz: 20_000_000,
  sampleCount: 4096,
  pretriggerPercent: 50,
  trigger: { mode: "immediate" },
};

interface ConnectedClient extends ClientState {
  send: (message: unknown) => void;
}

interface QueueJob<T = unknown> {
  sequence: number;
  priority: number;
  role: ClientRole;
  label: string;
  deviceId?: string;
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

interface DeviceContext {
  state: DeviceState;
  session: Ag32Session;
  customAlias: boolean;
  queue: QueueJob[];
  processing: boolean;
  sequence: number;
  currentJobPriority: number | null;
  activeCapture: ActiveCapture | null;
  repeatGeneration: number;
  repeatState: RepeatState;
  repeatRequest: Omit<CaptureRequest, "persist">;
  latestCapture: CaptureFrame | null;
}

interface CaptureResult {
  frame: CaptureFrame;
  hostReadyAt: string;
  hostRequestAt: string;
  hostStartAt: string;
  hostCompleteAt: string;
}

export class DaemonBroker {
  private readonly devices = new Map<string, DeviceContext>();
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly previewFrames: CaptureFrame[] = [];
  private readonly activity: ActivityItem[] = [];
  private readonly queue: QueueJob[] = [];
  private synchronizedCapture: SynchronizedCaptureGroup | null = null;
  private activeDeviceId: string | null = null;
  private processing = false;
  private sequence = 0;
  private storageUsage: StorageUsage = {
    previewBytes: 0,
    persistentBytes: 0,
    totalBytes: 0,
    limitBytes: 2 * 1024 * 1024 * 1024,
    previewFrames: 0,
    persistentRecords: 0,
  };

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
        return this.disconnect(params);
      case "disconnect_all":
        return this.disconnectAll();
      case "set_active_device":
        return this.setActiveDevice(params);
      case "set_device_index":
        return this.runOnDevice(role, params, "设置设备编号", true, (context) =>
          this.setDeviceIndex(context, params));
      case "get_device_info":
        return this.runOnDevice(role, params, "读取设备状态", false, (context) =>
          this.readDeviceState(context), true);
      case "capture": {
        const input = asRecord(params);
        const request = normalizeCaptureRequest(input);
        return this.runOnDevice(role, params, role === "mcp" ? "MCP 采集" : "采集波形", true, (context) =>
          this.captureFromRequest(context, role, request, role === "mcp").then((result) => result.frame));
      }
      case "capture_synchronized":
        return this.captureSynchronized(role, params);
      case "get_synchronized_capture": {
        const input = asRecordOrEmpty(params);
        if (input.id && this.synchronizedCapture?.id !== String(input.id)) {
          throw new Error(`未找到联合采集 ${String(input.id)}`);
        }
        return this.synchronizedCapture;
      }
      case "start_repeat":
        return this.runOnDevice(role, params, "启动重复采集", true, (context) =>
          this.startRepeat(context, role, params));
      case "stop_repeat":
        return this.runOnDevice(role, params, "停止重复采集", true, (context) =>
          this.stopRepeat(context));
      case "configure_pin5_square":
        return this.runOnDevice(role, params, "设置 PIN_5 方波", true, (context) =>
          this.configurePin5Square(context, params));
      case "configure_pin5_engine":
        return this.runOnDevice(role, params, "设置 PIN_5 引擎", true, (context) =>
          this.configurePin5Engine(context, params));
      case "pin5_engine_control":
        return this.runOnDevice(role, params, "控制 PIN_5 引擎", true, (context) =>
          this.controlPin5Engine(context, params));
      case "configure_pin11":
        return this.runOnDevice(role, params, "设置 PIN_11 输出", true, (context) =>
          this.configurePin11(context, params));
      case "configure_pin11_static":
        return this.runOnDevice(role, params, "设置 PIN_11 静态输出", true, (context) =>
          this.configurePin11Static(context, params));
      case "safe_idle":
        return this.runOnDevice(role, params, "输出安全空闲", true, (context) =>
          this.safeIdle(context));
      case "safe_idle_all":
        return this.safeIdleAll(role);
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
        return this.resolveLatestCapture(params);
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
    for (const context of this.devices.values()) {
      context.repeatState.active = false;
      context.repeatGeneration += 1;
      await context.activeCapture?.abort?.().catch(() => undefined);
    }
    await Promise.all([...this.devices.values()].map((context) =>
      context.session.disconnect().catch(() => undefined)));
    this.devices.clear();
    this.activeDeviceId = null;
  }

  private async snapshot(): Promise<AppSnapshot> {
    const active = this.activeContext();
    const devices = [...this.devices.values()].map((context) => context.state);
    return {
      devices,
      activeDeviceId: this.activeDeviceId,
      device: active?.state ?? emptyDeviceState(),
      repeat: active?.repeatState ?? emptyRepeatState(),
      repeats: [...this.devices.values()].map((context) => context.repeatState),
      clients: [...this.clients.values()].map(({ id, role, name }) => ({ id, role, name })),
      latestCapture: active?.latestCapture ?? this.synchronizedCapture?.frames[0]?.frame ?? null,
      latestCaptures: [...this.devices.values()]
        .map((context) => context.latestCapture)
        .filter((frame): frame is CaptureFrame => Boolean(frame)),
      synchronizedCapture: this.synchronizedCapture,
      activity: this.activity.slice(0, 20),
      storage: this.storageUsage,
    };
  }

  private async listDevices(params: unknown): Promise<DeviceListResult> {
    const input = asRecordOrEmpty(params);
    const preferPort = typeof input.preferPort === "string" ? input.preferPort : undefined;
    const rawPorts = await listSerialPorts();
    const ordered = preferPort
      ? [
          ...rawPorts.filter((port) => port.path === preferPort),
          ...rawPorts.filter((port) => port.path !== preferPort),
        ]
      : rawPorts;
    const devices: SerialPortInfo[] = [];
    for (const port of ordered) {
      const connected = [...this.devices.values()].find((context) => context.state.port === port.path);
      const identity = deviceIdentity(port);
      if (connected) {
        devices.push({
          ...port,
          identity: connected.state.identity,
          identityStable: connected.state.identityStable,
          connectedDeviceId: connected.state.deviceId,
          connectedAlias: connected.state.alias,
          sumpId: true,
          firmware: connected.state.info
            ? `v${connected.state.info.firmware.major}.${connected.state.info.firmware.minor}`
            : undefined,
          deviceIndex: connected.state.deviceIndex,
        });
        continue;
      }
      const device = await Ag32SerialDevice.open(port.path);
      if (!device) {
        devices.push({
          ...port,
          identity: identity.identity,
          identityStable: identity.stable,
          error: "端口不可用或已被占用",
        });
        continue;
      }
      try {
        const sumpId = await probeSumpId(device);
        const info = sumpId ? await readInfoFrame(device) : undefined;
        devices.push({
          ...port,
          identity: identity.identity,
          identityStable: identity.stable,
          sumpId,
          firmware: info ? `v${info.firmware.major}.${info.firmware.minor}` : undefined,
          deviceIndex: info?.deviceIndex ?? null,
        });
      } catch (error) {
        devices.push({
          ...port,
          identity: identity.identity,
          identityStable: identity.stable,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await device.close().catch(() => undefined);
      }
    }
    return {
      selected: this.activeContext()?.state.port
        ?? devices.find((device) => device.sumpId)?.path
        ?? null,
      devices,
    };
  }

  private async connect(params: unknown): Promise<DeviceState> {
    const input = asRecord(params);
    if (typeof input.port !== "string" || input.port.length === 0) throw new Error("缺少串口名称");
    const requestedIndex = optionalDeviceIndex(input.deviceIndex);
    if (input.deviceIndex !== undefined && (requestedIndex === undefined || requestedIndex === 0)) {
      throw new Error("设备编号必须是 1、2、3 或 4");
    }
    const port = input.port;
    const portInfo = (await listSerialPorts()).find((item) => item.path === port);
    const identity = deviceIdentity(portInfo ?? { path: port });
    const existing = this.devices.get(identity.identity);
    const alias = typeof input.alias === "string" && input.alias.trim()
      ? input.alias.trim().slice(0, 32)
      : undefined;
    if (existing) {
      const changedSlot = deviceSlot(requestedIndex);
      if (changedSlot && changedSlot !== existing.state.deviceIndex) {
        await this.assertIndexAvailable(changedSlot, existing.state.deviceId);
        const info = await existing.session.setDeviceIndex(changedSlot);
        existing.state = {
          ...existing.state,
          info,
          deviceIndex: info.deviceIndex,
          alias: existing.customAlias ? existing.state.alias : `#${changedSlot}`,
        };
      }
      if (alias) {
        existing.customAlias = true;
        existing.state = { ...existing.state, alias };
      }
      this.activeDeviceId = existing.state.deviceId;
      this.emitDevice(existing);
      return existing.state;
    }
    if (this.devices.size >= MAX_DEVICES) {
      throw new Error("当前版本最多同时连接 4 台 AG32 逻辑分析仪");
    }
    const explicitSlot = deviceSlot(requestedIndex);
    const slot = explicitSlot ?? this.nextAvailableIndex();
    if (!slot) throw new Error("没有可用的设备编号 1-4");
    await this.assertIndexAvailable(slot);
    const session = new Ag32Session();
    try {
      let info = await session.connect(port);
      info = await session.setDeviceIndex(slot);
      const context: DeviceContext = {
        state: {
          deviceId: identity.identity,
          alias: alias ?? `#${slot}`,
          identity: identity.identity,
          identityStable: identity.stable,
          connected: true,
          port,
          connectedAt: new Date().toISOString(),
          info,
          pin5: await session.getPin5Status().catch(() => null),
          pin11Static: null,
          deviceIndex: info.deviceIndex,
        },
        session,
        customAlias: Boolean(alias),
        queue: [],
        processing: false,
        sequence: 0,
        currentJobPriority: null,
        activeCapture: null,
        repeatGeneration: 0,
        repeatState: emptyRepeatState(identity.identity),
        repeatRequest: { ...DEFAULT_REPEAT_REQUEST },
        latestCapture: null,
      };
      this.devices.set(identity.identity, context);
      this.activeDeviceId = identity.identity;
      this.emitDevice(context);
      return context.state;
    } catch (error) {
      await session.disconnect().catch(() => undefined);
      throw error;
    }
  }

  private async disconnect(params: unknown): Promise<{ connected: false; deviceId: string }> {
    const context = this.resolveDevice(params);
    await this.stopRepeat(context);
    await context.session.disconnect();
    this.devices.delete(context.state.deviceId);
    if (this.activeDeviceId === context.state.deviceId) {
      this.activeDeviceId = this.devices.keys().next().value ?? null;
    }
    this.broadcast({ event: "device", data: context.state });
    this.emitSnapshot();
    return { connected: false, deviceId: context.state.deviceId };
  }

  private async disconnectAll(): Promise<{ disconnected: string[] }> {
    const ids = [...this.devices.keys()];
    for (const id of ids) {
      const context = this.devices.get(id);
      if (!context) continue;
      await this.stopRepeat(context);
      await context.session.disconnect().catch(() => undefined);
      this.devices.delete(id);
    }
    this.activeDeviceId = null;
    this.emitSnapshot();
    return { disconnected: ids };
  }

  private setActiveDevice(params: unknown): AppSnapshot["device"] {
    const input = asRecord(params);
    const deviceId = typeof input.deviceId === "string" ? input.deviceId : "";
    const context = this.devices.get(deviceId);
    if (!context) throw new Error(`设备 ${deviceId || "(空)"} 未连接`);
    this.activeDeviceId = deviceId;
    this.emitSnapshot();
    return context.state;
  }

  private async setDeviceIndex(context: DeviceContext, params: unknown): Promise<DeviceState> {
    const input = asRecord(params);
    const deviceIndex = optionalDeviceIndex(input.deviceIndex);
    if (deviceIndex === undefined || deviceIndex === 0) {
      throw new Error("设备编号必须是 1、2、3 或 4");
    }
    await this.assertIndexAvailable(deviceIndex, context.state.deviceId);
    const info = await context.session.setDeviceIndex(deviceIndex);
    context.state = {
      ...context.state,
      info,
      deviceIndex: info.deviceIndex,
      alias: context.customAlias ? context.state.alias : `#${deviceIndex}`,
    };
    this.emitDevice(context);
    return context.state;
  }

  private async readDeviceState(context: DeviceContext): Promise<DeviceState> {
    if (!context.state.connected) return context.state;
    context.state = {
      ...context.state,
      info: await context.session.getInfo(),
      pin5: await context.session.getPin5Status(),
    };
    this.emitDevice(context);
    return context.state;
  }

  private async startRepeat(
    context: DeviceContext,
    role: ClientRole,
    params: unknown,
  ): Promise<RepeatState> {
    const input = asRecord(params);
    const fps = Math.max(1, Math.min(30, Number(input.fps) || 20));
    context.repeatRequest = normalizeCaptureRequest(input.request);
    context.repeatState = {
      active: true,
      fps,
      ownerRole: role,
      deviceId: context.state.deviceId,
    };
    context.repeatGeneration += 1;
    const generation = context.repeatGeneration;
    void this.runRepeatLoop(context, generation);
    this.emitSnapshot();
    return context.repeatState;
  }

  private async stopRepeat(context: DeviceContext): Promise<RepeatState> {
    context.repeatState = {
      ...context.repeatState,
      active: false,
      ownerRole: null,
      deviceId: context.state.deviceId,
    };
    context.repeatGeneration += 1;
    this.requestCaptureYield(context, 0);
    this.emitSnapshot();
    return context.repeatState;
  }

  private async runRepeatLoop(context: DeviceContext, generation: number): Promise<void> {
    while (context.repeatState.active && generation === context.repeatGeneration) {
      const started = Date.now();
      try {
        await this.withDeviceQueue(
          context,
          context.repeatState.ownerRole ?? "desktop",
          "预览采集",
          30,
          false,
          () => this.captureFromRequest(
            context,
            context.repeatState.ownerRole ?? "desktop",
            context.repeatRequest,
            false,
          ),
        );
      } catch (error) {
        if (!(error instanceof CaptureAbortedError)) {
          this.pushActivity({
            role: context.repeatState.ownerRole ?? "desktop",
            deviceId: context.state.deviceId,
            label: `${context.state.alias} 重复采集失败`,
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const interval = 1000 / Math.max(1, context.repeatState.fps);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, interval - (Date.now() - started))));
    }
  }

  private async captureSynchronized(
    role: ClientRole,
    params: unknown,
  ): Promise<SynchronizedCaptureGroup> {
    const input = asRecord(params);
    const requestedIds = Array.isArray(input.deviceIds)
      ? input.deviceIds.map(String)
      : [...this.devices.keys()];
    const contexts = requestedIds.map((id) => {
      const context = this.devices.get(id);
      if (!context) throw new Error(`设备 ${id} 未连接`);
      return context;
    });
    if (contexts.length === 0) throw new Error("没有可用于联合采集的设备");
    if (contexts.length > MAX_DEVICES) throw new Error("联合采集最多支持 4 台设备");
    if (new Set(contexts.map((context) => context.state.deviceId)).size !== contexts.length) {
      throw new Error("联合采集设备列表包含重复项");
    }
    const request = normalizeCaptureRequest(input.request ?? input);
    const priority = this.priority(role);
    const results = await Promise.all(contexts.map((context) =>
      this.withDeviceQueue(
        context,
        role,
        role === "mcp" ? "MCP 联合采集" : "联合采集",
        priority,
        true,
        () => this.captureFromRequest(context, role, request, role === "mcp"),
      )));
    const requestStarted = Math.min(...results.map((result) =>
      Date.parse(result.hostRequestAt)));
    const completed = Math.max(...results.map((result) => Date.parse(result.hostCompleteAt)));
    const createdAt = new Date().toISOString();
    const entries: SynchronizedCaptureEntry[] = results.map((result) => ({
      deviceId: result.frame.deviceId ?? "",
      alias: result.frame.deviceAlias ?? "",
      frame: result.frame,
      hostReadyAt: result.hostReadyAt,
      hostRequestAt: result.hostRequestAt,
      hostStartAt: result.hostStartAt,
      hostCompleteAt: result.hostCompleteAt,
    }));
    const group: SynchronizedCaptureGroup = {
      id: `${createdAt.replace(/[:.]/g, "-")}-group-${Math.random().toString(36).slice(2, 7)}`,
      createdAt,
      deviceIds: entries.map((entry) => entry.deviceId),
      syncMode: "software",
      hardwareSynchronized: false,
      maxStartSkewMs: Math.max(...results.map((result) =>
        Math.abs(Date.parse(result.hostRequestAt) - requestStarted))),
      durationMs: completed - requestStarted,
      request,
      frames: entries,
      note: "偏差只表示主机发出采集请求的时间差，不代表设备真实触发偏差。各设备仍由自身采样时钟计时；严格时序比较需要公共外部触发和公共参考时钟。",
    };
    this.synchronizedCapture = group;
    this.broadcast({ event: "group_capture", data: group });
    this.emitSnapshot();
    return group;
  }

  private async captureFromRequest(
    context: DeviceContext,
    role: ClientRole,
    request: CaptureRequest,
    forcePersistent: boolean,
  ): Promise<CaptureResult> {
    const capturePriority = context.currentJobPriority ?? this.priority(role);
    const active: ActiveCapture = { priority: capturePriority, abort: null, yieldTimer: null };
    const hostReadyAt = new Date().toISOString();
    const hostRequestAt = new Date().toISOString();
    const result = await context.session.capture(
      {
        sampleRateHz: request.sampleRateHz,
        sampleCount: request.sampleCount,
        pretriggerPercent: request.pretriggerPercent,
        trigger: request.trigger,
      },
      {
        registerAbort: (abort) => {
          active.abort = abort;
          context.activeCapture = active;
          const queuedPriority = context.queue[0]?.priority;
          if (queuedPriority !== undefined) this.requestCaptureYield(context, queuedPriority);
        },
      },
    ).finally(() => {
      if (context.activeCapture === active) context.activeCapture = null;
      if (active.yieldTimer) clearTimeout(active.yieldTimer);
    });

    const measurements = analyzeSamples(
      result.samples,
      result.actualSampleRateHz,
    ) as CaptureFrame["channels"];
    const activeChannels = findActiveChannels(measurements) as ChannelName[];
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
    let frame: CaptureFrame = {
      id,
      deviceId: context.state.deviceId,
      deviceAlias: context.state.alias,
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
    context.latestCapture = frame;
    this.broadcast({ event: "capture", data: frame });
    if (frame.persistent) this.emitSnapshot();
    return {
      frame,
      hostReadyAt,
      hostRequestAt,
      hostStartAt: hostRequestAt,
      hostCompleteAt: new Date().toISOString(),
    };
  }

  private async configurePin5Square(context: DeviceContext, params: unknown): Promise<DeviceState> {
    const input = asRecord(params);
    const frequencyHz = Math.round(Number(input.frequencyHz));
    if (!Number.isFinite(frequencyHz) || frequencyHz < 1 || frequencyHz > 100_000_000) {
      throw new Error("PIN_5 方波频率必须在 1 Hz 至 100 MHz");
    }
    context.state = {
      ...context.state,
      pin5: await context.session.configurePin5SquareWave(frequencyHz),
      info: await context.session.getInfo(),
    };
    this.emitDevice(context);
    return context.state;
  }

  private async configurePin5Engine(context: DeviceContext, params: unknown): Promise<DeviceState> {
    const config = normalizePin5Engine(params);
    context.state = {
      ...context.state,
      pin5: await context.session.configurePin5Engine(config),
      info: await context.session.getInfo(),
    };
    this.emitDevice(context);
    return context.state;
  }

  private async controlPin5Engine(context: DeviceContext, params: unknown): Promise<DeviceState> {
    const input = asRecord(params);
    const action = String(input.action) as "arm" | "fire" | "reset";
    if (!["arm", "fire", "reset"].includes(action)) throw new Error("PIN_5 控制动作无效");
    context.state = {
      ...context.state,
      pin5: await context.session.pin5EngineControl(action),
      info: await context.session.getInfo(),
    };
    this.emitDevice(context);
    return context.state;
  }

  private async configurePin11(context: DeviceContext, params: unknown): Promise<DeviceState> {
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
    const info = await context.session.configurePin11(config);
    context.state = { ...context.state, info, pin11Static: config.enabled ? null : 0 };
    this.emitDevice(context);
    return context.state;
  }

  private async configurePin11Static(context: DeviceContext, params: unknown): Promise<DeviceState> {
    const input = asRecord(params);
    const mode = Number(input.mode);
    if (mode !== 0 && mode !== 1 && mode !== 2) throw new Error("PIN_11 静态输出模式必须是 0、1 或 2");
    await context.session.configurePin11Static(mode);
    context.state = {
      ...context.state,
      info: await context.session.getInfo(),
      pin11Static: mode,
    };
    this.emitDevice(context);
    return context.state;
  }

  private async safeIdle(context: DeviceContext): Promise<DeviceState> {
    const result = await context.session.safeIdle();
    context.state = {
      ...context.state,
      info: result.info,
      pin5: result.pin5,
      pin11Static: 0,
    };
    this.emitDevice(context);
    return context.state;
  }

  private async safeIdleAll(role: ClientRole): Promise<DeviceState[]> {
    const contexts = [...this.devices.values()];
    const results = await Promise.all(contexts.map((context) =>
      this.withDeviceQueue(context, role, "全部设备安全空闲", this.priority(role), true, () =>
        this.safeIdle(context))));
    return results;
  }

  private resolveLatestCapture(params: unknown): CaptureFrame | null | SynchronizedCaptureGroup {
    const input = asRecordOrEmpty(params);
    if (input.group === true) return this.synchronizedCapture;
    if (input.deviceId !== undefined) return this.resolveDevice(params).latestCapture;
    return this.activeContext()?.latestCapture ?? null;
  }

  private activeContext(): DeviceContext | null {
    return this.activeDeviceId ? this.devices.get(this.activeDeviceId) ?? null : null;
  }

  private resolveDevice(params: unknown): DeviceContext {
    const input = asRecordOrEmpty(params);
    const deviceId = typeof input.deviceId === "string"
      ? input.deviceId
      : typeof input.id === "string" && this.devices.has(input.id)
        ? input.id
        : this.activeDeviceId;
    if (!deviceId) throw new Error("设备尚未连接");
    const context = this.devices.get(deviceId);
    if (!context) throw new Error(`设备 ${deviceId} 未连接`);
    return context;
  }

  private nextAvailableIndex(): 1 | 2 | 3 | 4 | null {
    const used = new Set([...this.devices.values()].map((context) => context.state.deviceIndex));
    for (const index of [1, 2, 3, 4] as const) {
      if (!used.has(index)) return index;
    }
    return null;
  }

  private async assertIndexAvailable(index: 1 | 2 | 3 | 4, exceptDeviceId?: string): Promise<void> {
    const duplicate = [...this.devices.values()].find((context) =>
      context.state.deviceId !== exceptDeviceId && context.state.deviceIndex === index);
    if (duplicate) {
      throw new Error(`设备编号 #${index} 已被 ${duplicate.state.alias} (${duplicate.state.port}) 使用`);
    }
  }

  private async runOnDevice<T>(
    role: ClientRole,
    params: unknown,
    label: string,
    trackActivity: boolean,
    work: (context: DeviceContext) => Promise<T>,
    allowDisconnected = false,
  ): Promise<T> {
    const context = this.resolveDevice(params);
    if (!allowDisconnected && !context.state.connected) throw new Error("设备尚未连接");
    return this.withDeviceQueue(
      context,
      role,
      `${context.state.alias} · ${label}`,
      this.priority(role),
      trackActivity,
      () => work(context),
    );
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

  private emitDevice(context: DeviceContext): void {
    this.broadcast({ event: "device", data: context.state });
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

  private updateActivity(
    id: string,
    status: ActivityItem["status"],
    detail?: string,
  ): void {
    const item = this.activity.find((entry) => entry.id === id);
    if (!item) return;
    item.status = status;
    item.detail = detail;
    this.broadcast({ event: "activity", data: item });
  }

  private priority(role: ClientRole): number {
    return role === "mcp" ? 10 : 20;
  }

  private withQueue<T>(
    role: ClientRole,
    label: string,
    priority: number,
    trackActivity: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
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
      }
    }
    this.processing = false;
  }

  private withDeviceQueue<T>(
    context: DeviceContext,
    role: ClientRole,
    label: string,
    priority: number,
    trackActivity: boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    this.requestCaptureYield(context, priority);
    return new Promise<T>((resolve, reject) => {
      context.queue.push({
        sequence: context.sequence++,
        priority,
        role,
        label,
        deviceId: context.state.deviceId,
        trackActivity,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      context.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      void this.runDeviceQueue(context);
    });
  }

  private async runDeviceQueue(context: DeviceContext): Promise<void> {
    if (context.processing) return;
    context.processing = true;
    while (context.queue.length > 0) {
      const job = context.queue.shift();
      if (!job) break;
      context.currentJobPriority = job.priority;
      const activity = job.trackActivity
        ? this.pushActivity({
            role: job.role,
            deviceId: job.deviceId,
            label: job.label,
            status: "running",
          })
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
        context.currentJobPriority = null;
      }
    }
    context.processing = false;
  }

  private requestCaptureYield(context: DeviceContext, incomingPriority: number): void {
    const active = context.activeCapture;
    if (!active || !active.abort || active.priority <= incomingPriority || active.yieldTimer) return;
    active.yieldTimer = setTimeout(() => {
      if (context.activeCapture === active) void active.abort?.().catch(() => undefined);
    }, 200);
  }
}

function deviceIdentity(port: {
  path: string;
  serialNumber?: string;
  locationId?: string;
  pnpId?: string;
}): { identity: string; stable: boolean } {
  const serial = port.serialNumber?.trim();
  if (serial && serial !== "123456") {
    return { identity: `usb-serial:${serial}`, stable: true };
  }
  if (port.locationId) {
    return { identity: `usb-location:${port.locationId}`, stable: false };
  }
  if (port.pnpId) {
    return { identity: `usb-pnp:${port.pnpId}`, stable: false };
  }
  return { identity: `port:${port.path}`, stable: false };
}

function emptyDeviceState(): DeviceState {
  return {
    deviceId: "",
    alias: "",
    identity: "",
    identityStable: false,
    connected: false,
    port: null,
    connectedAt: null,
    info: null,
    pin5: null,
    pin11Static: null,
    deviceIndex: null,
  };
}

function emptyRepeatState(deviceId?: string): RepeatState {
  return { active: false, fps: 20, ownerRole: null, deviceId: deviceId ?? null };
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

function deviceSlot(value: unknown): 1 | 2 | 3 | 4 | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
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
