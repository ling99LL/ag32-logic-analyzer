import type {
  AppSettings,
  AppSnapshot,
  CaptureFrame,
  CaptureRequest,
  DaemonEvent,
  DaemonMethod,
  DeviceListResult,
  HistoryRecord,
  Pin11Config,
  Pin5EngineConfig,
  StorageUsage,
} from "./types.js";

export interface Ag32DesktopApi {
  invoke<T = unknown>(method: DaemonMethod, params?: unknown): Promise<T>;
  subscribe(listener: (event: DaemonEvent) => void): () => void;
  platform: string;
}

export interface Ag32InvokeMap {
  snapshot: AppSnapshot;
  list_devices: DeviceListResult;
  connect: { connected: true; port: string };
  disconnect: { connected: false };
  get_device_info: AppSnapshot["device"];
  capture: CaptureFrame;
  start_repeat: AppSnapshot["repeat"];
  stop_repeat: AppSnapshot["repeat"];
  configure_pin5_square: AppSnapshot["device"];
  configure_pin5_engine: AppSnapshot["device"];
  pin5_engine_control: AppSnapshot["device"];
  configure_pin11: AppSnapshot["device"];
  configure_pin11_static: AppSnapshot["device"];
  safe_idle: AppSnapshot["device"];
  history_list: HistoryRecord[];
  history_load: CaptureFrame;
  history_favorite: HistoryRecord;
  history_delete: { deleted: true; id: string };
  storage_usage: StorageUsage;
  get_latest_capture: CaptureFrame | null;
  get_settings: AppSettings;
  save_settings: AppSettings;
}

export interface Ag32InvokePayloads {
  connect: { port: string };
  capture: CaptureRequest;
  start_repeat: { fps: number; request: Omit<CaptureRequest, "persist"> };
  configure_pin5_square: { frequencyHz: number };
  configure_pin5_engine: Pin5EngineConfig;
  pin5_engine_control: { action: "arm" | "fire" | "reset" };
  configure_pin11: Pin11Config;
  configure_pin11_static: { mode: 0 | 1 | 2 };
  history_favorite: { id: string; favorite: boolean };
  history_load: { id: string };
  history_delete: { id: string };
  save_settings: AppSettings;
}
