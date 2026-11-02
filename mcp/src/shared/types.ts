export const APP_NAME = "AG32 Logic Studio";
export const CHANNELS = ["CH1", "CH2", "CH3", "CH4"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export const WAVE_TYPES = ["sine", "square", "sawtooth", "triangle"] as const;
export type WaveType = (typeof WAVE_TYPES)[number];

export const PIN5_TRIGGER_MODES = [
  "delayed_level",
  "delayed_pulse",
  "host_level",
  "host_pulse",
] as const;
export type Pin5TriggerMode = (typeof PIN5_TRIGGER_MODES)[number];

export const CLIENT_ROLES = ["desktop", "mcp", "cli"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];
export const UI_THEMES = ["graphite", "slate", "light", "ember"] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export type TriggerMode = "immediate" | "level" | "edge";
export type EdgeDirection = "rising" | "falling";

export interface TriggerEdge {
  channel: ChannelName;
  direction: EdgeDirection;
}

export interface CaptureTrigger {
  mode: TriggerMode;
  channels?: ChannelName[];
  highChannels?: ChannelName[];
  edges?: TriggerEdge[];
}

export interface CaptureRequest {
  sampleRateHz: number;
  sampleCount: number;
  pretriggerPercent?: number;
  trigger?: CaptureTrigger;
  persist?: boolean;
}

export interface FirmwareInfo {
  firmware: { major: number; minor: number };
  waveform: WaveType;
  amplitudePercent: number;
  requestedFrequencyHz: number;
  actualFrequencyHz: number;
  flags: number;
  tableLength: number;
  rateCapHz: number;
  deviceIndex: 1 | 2 | 3 | 4 | null;
}

export interface Pin5Status {
  busy: boolean;
  done: boolean;
  outputHigh: boolean;
  remainingTicks: number;
  config: number;
  squareSelected: boolean;
  tickNs: number;
  remainingNs: number;
}

export interface ChannelMeasurement {
  channel: ChannelName;
  pin: string;
  bit: number;
  highCount: number;
  lowCount: number;
  edgeCount: number;
  firstEdgeIndex: number | null;
  lastEdgeIndex: number | null;
  firstEdgeTimeNs: number | null;
  lastEdgeTimeNs: number | null;
  estimatedFrequencyHz: number | null;
}

export interface CaptureArtifacts {
  directory: string;
  manifestPath: string;
  samplesPath: string;
  vcdPath: string;
}

export interface CaptureFrame {
  id: string;
  deviceId?: string;
  deviceAlias?: string;
  createdAt: string;
  source: ClientRole;
  persistent: boolean;
  requestedSampleRateHz: number;
  actualSampleRateHz: number;
  divider: number;
  sampleCount: number;
  pretriggerPercent: number;
  trigger: CaptureTrigger;
  activeChannels: ChannelName[];
  channels: ChannelMeasurement[];
  samplesBase64: string;
  artifacts?: CaptureArtifacts;
}

export interface HistoryRecord {
  id: string;
  deviceId?: string;
  deviceAlias?: string;
  createdAt: string;
  source: ClientRole;
  sampleRateHz: number;
  sampleCount: number;
  favorite: boolean;
  sizeBytes: number;
  directory: string;
  manifestPath: string;
  samplesPath: string;
  vcdPath: string;
  trigger: CaptureTrigger;
  channels: ChannelMeasurement[];
}

export interface StorageUsage {
  previewBytes: number;
  persistentBytes: number;
  totalBytes: number;
  limitBytes: number;
  previewFrames: number;
  persistentRecords: number;
}

export interface RepeatState {
  active: boolean;
  fps: number;
  ownerRole: ClientRole | null;
  deviceId?: string | null;
}

export interface DeviceState {
  deviceId: string;
  alias: string;
  identity: string;
  identityStable: boolean;
  connected: boolean;
  port: string | null;
  connectedAt: string | null;
  info: FirmwareInfo | null;
  pin5: Pin5Status | null;
  pin11Static: 0 | 1 | 2 | null;
  deviceIndex: 1 | 2 | 3 | 4 | null;
}

export interface ClientState {
  id: string;
  role: ClientRole;
  name: string;
}

export interface ActivityItem {
  id: string;
  at: string;
  deviceId?: string;
  role: ClientRole;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
}

export interface AppSnapshot {
  devices: DeviceState[];
  activeDeviceId: string | null;
  device: DeviceState;
  repeat: RepeatState;
  clients: ClientState[];
  latestCapture: CaptureFrame | null;
  latestCaptures: CaptureFrame[];
  synchronizedCapture: SynchronizedCaptureGroup | null;
  activity: ActivityItem[];
  storage: StorageUsage;
}

export interface SynchronizedCaptureEntry {
  deviceId: string;
  alias: string;
  frame: CaptureFrame;
  hostReadyAt: string;
  hostStartAt: string;
  hostCompleteAt: string;
}

export interface SynchronizedCaptureGroup {
  id: string;
  createdAt: string;
  deviceIds: string[];
  syncMode: "software";
  hardwareSynchronized: false;
  maxStartSkewMs: number;
  durationMs: number;
  request: CaptureRequest;
  frames: SynchronizedCaptureEntry[];
  note: string;
}

export interface Pin5EngineConfig {
  mode: Pin5TriggerMode;
  activeLevel: "high" | "low";
  idleLevel: "high" | "low";
  delayNs: number;
  widthNs: number;
  action?: "arm" | "fire" | "reset";
}

export interface Pin11Config {
  waveform: WaveType;
  frequencyHz: number;
  amplitudePercent: number;
  enabled: boolean;
  rateCapHz?: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  identity?: string;
  identityStable?: boolean;
  connectedDeviceId?: string;
  connectedAlias?: string;
  sumpId?: boolean;
  firmware?: string;
  deviceIndex?: 1 | 2 | 3 | 4 | null;
  error?: string;
}

export interface DeviceListResult {
  selected: string | null;
  devices: SerialPortInfo[];
}

export interface AppSettings {
  theme: UiTheme;
  sampleRateHz: number;
  sampleCount: number;
  pretriggerPercent: number;
  repeatFps: number;
  triggerMode: TriggerMode;
  triggerChannels: ChannelName[];
  highChannels: ChannelName[];
  edges: TriggerEdge[];
  pin5SquareHz: number;
  pin5Engine: Pin5EngineConfig;
  pin11: Pin11Config;
  channelVisibility: Record<ChannelName, boolean>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "graphite",
  sampleRateHz: 20_000_000,
  sampleCount: 4_096,
  pretriggerPercent: 50,
  repeatFps: 20,
  triggerMode: "immediate",
  triggerChannels: ["CH1"],
  highChannels: ["CH1"],
  edges: [{ channel: "CH1", direction: "rising" }],
  pin5SquareHz: 100_000,
  pin5Engine: {
    mode: "delayed_pulse",
    activeLevel: "high",
    idleLevel: "low",
    delayNs: 1_000_000,
    widthNs: 500_000,
  },
  pin11: {
    waveform: "sine",
    frequencyHz: 100_000,
    amplitudePercent: 80,
    enabled: false,
  },
  channelVisibility: {
    CH1: true,
    CH2: true,
    CH3: true,
    CH4: true,
  },
};

export type DaemonMethod =
  | "snapshot"
  | "list_devices"
  | "connect"
  | "disconnect"
  | "disconnect_all"
  | "set_active_device"
  | "set_device_index"
  | "get_device_info"
  | "capture"
  | "capture_synchronized"
  | "get_synchronized_capture"
  | "start_repeat"
  | "stop_repeat"
  | "configure_pin5_square"
  | "configure_pin5_engine"
  | "pin5_engine_control"
  | "configure_pin11"
  | "configure_pin11_static"
  | "safe_idle"
  | "safe_idle_all"
  | "history_list"
  | "history_load"
  | "history_favorite"
  | "history_delete"
  | "storage_usage"
  | "get_latest_capture"
  | "get_settings"
  | "save_settings";

export interface DaemonRequest {
  id: string;
  method: DaemonMethod;
  params?: unknown;
}

export interface DaemonHello {
  id: string;
  method: "hello";
  params: {
    role: ClientRole;
    name: string;
  };
}

export interface DaemonResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface DaemonEvent<T = unknown> {
  event: "capture" | "snapshot" | "activity" | "device" | "group_capture";
  data: T;
}
