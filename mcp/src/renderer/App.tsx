import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, ArrowUpRight, AudioWaveform, Check, ChevronRight,
  Boxes, Cable, CircleStop, Clock3, Cpu, Database, FolderClock, Gauge, GitCompareArrows,
  HardDrive, Link2, Pause, Play, Power, Radio, RefreshCw, ScanLine, SquareActivity,
  Unplug, Usb, X, Zap,
} from "lucide-react";
import { api, isMockMode } from "./api.js";
import { WaveformCanvas } from "./components/WaveformCanvas.js";
import { GroupWaveformCanvas } from "./components/GroupWaveformCanvas.js";
import { Segmented, SignalSources } from "./components/SignalSources.js";
import { HistoryView } from "./components/HistoryView.js";
import { formatBytes, formatFrequency, formatTime, sampleRateChoices } from "./format.js";
import {
  cloneOutputDraft,
  createOutputDraft,
  outputDomainSignature,
} from "./output.js";
import type { OutputDraft, Pin11OutputMode } from "./output.js";
import type {
  AppSettings, AppSnapshot, CaptureFrame, ChannelName, DaemonEvent, DaemonMethod,
  DeviceListResult, DeviceState, HistoryRecord, Pin11Config, Pin5EngineConfig,
  RepeatState, StorageUsage, SynchronizedCaptureGroup,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

type ViewName = "analyzer" | "outputs" | "history";
type DeviceIndex = 1 | 2 | 3 | 4;
type AnalyzerMode = "multi" | "single" | "group";
interface DeviceOutputBaseline {
  pin5: string;
  pin11: string;
}
const CHANNEL_NAMES: ChannelName[] = ["CH1", "CH2", "CH3", "CH4"];
const DEVICE_INDEX_BY_PORT_KEY = "ag32.deviceIndexByPort";
const PORT_BY_DEVICE_SLOT_KEY = "ag32.portByDeviceSlot";
const EMPTY_DEVICE: AppSnapshot["device"] = {
  deviceId: "", alias: "", identity: "", identityStable: false,
  connected: false, port: null, connectedAt: null, info: null, pin5: null,
  pin11Static: null, deviceIndex: null,
};

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [latestCapture, setLatestCapture] = useState<CaptureFrame | null>(null);
  const [deviceList, setDeviceList] = useState<DeviceListResult | null>(null);
  const [selectedPort, setSelectedPort] = useState("COM33");
  const [deviceIndex, setDeviceIndexState] = useState<DeviceIndex>(() => savedDeviceIndex("COM33"));
  const [portBySlot, setPortBySlot] = useState<Record<DeviceIndex, string>>(loadPortBySlot);
  const [connectingSlot, setConnectingSlot] = useState<DeviceIndex | null>(null);
  const [groupCapture, setGroupCapture] = useState<SynchronizedCaptureGroup | null>(null);
  const [analyzerMode, setAnalyzerMode] = useState<AnalyzerMode>("single");
  const [historyFrame, setHistoryFrame] = useState<CaptureFrame | null>(null);
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null);
  const [outputDrafts, setOutputDrafts] = useState<Record<string, OutputDraft>>({});
  const [outputSubmitted, setOutputSubmitted] = useState<Record<string, OutputDraft>>({});
  const [outputBaselines, setOutputBaselines] = useState<Record<string, DeviceOutputBaseline>>({});
  const [view, setView] = useState<ViewName>("analyzer");
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const eventRef = useRef<(event: DaemonEvent) => void>(() => undefined);
  const previousDeviceCountRef = useRef(0);
  const busy = busyCount > 0;
  const connected = Boolean(snapshot?.device.connected);
  const connectedDevices = snapshot?.devices ?? [];
  const mcpClient = snapshot?.clients.find((client) => client.role === "mcp");
  const storage = snapshot?.storage ?? null;
  const deviceIdsKey = connectedDevices.map((device) => device.deviceId).join("|");
  const framesByDevice = useMemo(() => {
    const frames = new Map<string, CaptureFrame>();
    for (const frame of snapshot?.latestCaptures ?? []) {
      if (frame.deviceId) frames.set(frame.deviceId, frame);
    }
    if (latestCapture?.deviceId) frames.set(latestCapture.deviceId, latestCapture);
    return frames;
  }, [latestCapture, snapshot?.latestCaptures]);
  const repeatsByDevice = useMemo(() => {
    const repeats = new Map<string, RepeatState>();
    for (const repeat of snapshot?.repeats ?? (snapshot?.repeat ? [snapshot.repeat] : [])) {
      if (repeat.deviceId) repeats.set(repeat.deviceId, repeat);
    }
    return repeats;
  }, [snapshot?.repeat, snapshot?.repeats]);
  const activeCapture = snapshot?.latestCaptures.find(
    (frame) => frame.deviceId === snapshot.activeDeviceId,
  ) ?? (latestCapture?.deviceId === snapshot?.activeDeviceId ? latestCapture : null);
  const displayFrame = historyFrame ?? activeCapture;
  const activeRepeat = repeatsByDevice.get(snapshot?.activeDeviceId ?? "");
  const repeatActive = Boolean(activeRepeat?.active);
  const activeRepeatCount = [...repeatsByDevice.values()].filter((repeat) => repeat.active).length;
  const selectedOutputDevice = connectedDevices.find(
    (device) => device.deviceId === outputDeviceId,
  ) ?? connectedDevices[0] ?? EMPTY_DEVICE;
  const selectedOutputDraft = outputDrafts[selectedOutputDevice.deviceId]
    ?? createOutputDraft(settings, selectedOutputDevice);
  const selectedHardwareBaseline = outputBaselines[selectedOutputDevice.deviceId];
  const selectedHardwareChanged = Boolean(selectedOutputDevice.deviceId)
    && Boolean(selectedHardwareBaseline)
    && (
      selectedHardwareBaseline.pin5 !== pin5HardwareFingerprint(selectedOutputDevice)
      || selectedHardwareBaseline.pin11 !== pin11HardwareFingerprint(selectedOutputDevice)
    );
  const selectedSubmittedDraft = outputSubmitted[selectedOutputDevice.deviceId];
  const selectedPin5Dirty = Boolean(selectedSubmittedDraft)
    && outputDomainSignature(selectedOutputDraft, "pin5")
      !== outputDomainSignature(selectedSubmittedDraft, "pin5");
  const selectedPin11Dirty = Boolean(selectedSubmittedDraft)
    && outputDomainSignature(selectedOutputDraft, "pin11")
      !== outputDomainSignature(selectedSubmittedDraft, "pin11");
  const selectedDraftDirty = selectedPin5Dirty || selectedPin11Dirty;
  const selectedDirtyDomains = [
    selectedPin5Dirty ? "PIN_5" : null,
    selectedPin11Dirty ? "PIN_11" : null,
  ].filter((domain): domain is string => Boolean(domain));

  useEffect(() => {
    eventRef.current = (event: DaemonEvent) => {
      if (event.event === "capture") {
        const frame = event.data as CaptureFrame;
        setLatestCapture(frame);
        setNotice(frame.source === "mcp" ? "已接收 MCP 采集帧" : null);
      } else if (event.event === "group_capture") {
        const group = event.data as SynchronizedCaptureGroup;
        setGroupCapture(group);
        setAnalyzerMode("group");
        setHistoryFrame(null);
        setNotice(`联合采集完成：${group.frames.length} 台设备，主机请求偏差 ${group.maxStartSkewMs.toFixed(1)} ms`);
      } else if (event.event === "snapshot") {
        const next = event.data as AppSnapshot;
        setSnapshot(next);
        if (next.latestCapture) setLatestCapture(next.latestCapture);
        if (next.synchronizedCapture) setGroupCapture(next.synchronizedCapture);
      } else if (event.event === "device") {
        const state = event.data as AppSnapshot["device"];
        setSnapshot((current) => {
          if (!current) return current;
          const devices = state.connected
            ? current.devices.some((device) => device.deviceId === state.deviceId)
              ? current.devices.map((device) => device.deviceId === state.deviceId ? state : device)
              : [...current.devices, state]
            : current.devices.filter((device) => device.deviceId !== state.deviceId);
          const activeDeviceId = devices.some((device) => device.deviceId === current.activeDeviceId)
            ? current.activeDeviceId
            : devices[0]?.deviceId ?? null;
          return {
            ...current,
            devices,
            activeDeviceId,
            device: devices.find((device) => device.deviceId === activeDeviceId) ?? EMPTY_DEVICE,
          };
        });
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => eventRef.current(event));
    void bootstrap();
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = window.setTimeout(() => {
      void api.invoke("save_settings", settings).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [settings, settingsLoaded]);

  useEffect(() => {
    const devices = snapshot?.devices ?? [];
    const previousCount = previousDeviceCountRef.current;
    const count = devices.length;
    if (count === 0) {
      setAnalyzerMode("single");
    } else if (count === 1 && previousCount === 0) {
      setAnalyzerMode("single");
    } else if (count > previousCount && count > 1 && !historyFrame) {
      setAnalyzerMode("multi");
    }
    previousDeviceCountRef.current = count;
  }, [deviceIdsKey, historyFrame]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const devices = snapshot?.devices ?? [];
    setOutputDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const device of devices) {
        if (!next[device.deviceId]) {
          next[device.deviceId] = createOutputDraft(settings, device);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setOutputSubmitted((current) => {
      const next = { ...current };
      let changed = false;
      for (const device of devices) {
        if (!next[device.deviceId]) {
          next[device.deviceId] = createOutputDraft(settings, device);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setOutputBaselines((current) => {
      const next = { ...current };
      let changed = false;
      for (const device of devices) {
        if (!next[device.deviceId]) {
          next[device.deviceId] = deviceOutputBaseline(device);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setOutputDeviceId((current) =>
      current && devices.some((device) => device.deviceId === current)
        ? current
        : devices[0]?.deviceId ?? null);
  }, [deviceIdsKey, settingsLoaded]);

  useEffect(() => { if (view === "history") void refreshHistory(); }, [view]);
  useEffect(() => {
    if (!notice && !error) return;
    const timer = window.setTimeout(() => { setNotice(null); setError(null); }, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, error]);

  async function bootstrap(): Promise<void> {
    try {
      const [initialSnapshot, savedSettings] = await Promise.all([
        api.invoke<AppSnapshot>("snapshot"), api.invoke<AppSettings>("get_settings"),
      ]);
      setSnapshot(initialSnapshot);
      setLatestCapture(initialSnapshot.latestCapture);
      setGroupCapture(initialSnapshot.synchronizedCapture);
      setAnalyzerMode(initialSnapshot.devices.length > 1 ? "multi" : "single");
      setSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
      setSettingsLoaded(true);
      await scanDevices();
    } catch (failure) { setError(errorText(failure)); }
  }

  async function scanDevices(): Promise<void> {
    setScanning(true);
    try {
      const result = await api.invoke<DeviceListResult>("list_devices");
      setDeviceList(result);
      hydratePortSlots(result);
      const nextPort = result.selected ?? result.devices.find((device) => device.sumpId)?.path
        ?? result.devices[0]?.path ?? selectedPort;
      if (nextPort) choosePort(nextPort);
    } catch (failure) { setError(errorText(failure)); }
    finally { setScanning(false); }
  }

  async function connect(): Promise<void> {
    await operation(async () => {
      await api.invoke("connect", { port: selectedPort, deviceIndex });
      const next = await api.invoke<AppSnapshot>("snapshot");
      setSnapshot(next);
      setAnalyzerMode(next.devices.length > 1 ? "multi" : "single");
      setNotice(`已连接 ${selectedPort}，设备 ${deviceIndex} 点亮 LED${deviceIndex}`);
    });
  }
  async function disconnect(): Promise<void> {
    await operation(async () => {
      await api.invoke("disconnect", { deviceId: snapshot?.activeDeviceId });
      const next = await api.invoke<AppSnapshot>("snapshot");
      setSnapshot(next);
      if (next.devices.length < 2) setAnalyzerMode("single");
      setNotice("设备已断开");
    });
  }
  function choosePort(port: string): void {
    setSelectedPort(port);
    setDeviceIndexState(savedDeviceIndex(port));
  }
  function hydratePortSlots(result: DeviceListResult): void {
    setPortBySlot((current) => {
      const next = { ...current };
      const sumpPorts = result.devices.filter((device) => device.sumpId);
      for (const index of [1, 2, 3, 4] as DeviceIndex[]) {
        const connectedPort = snapshot?.devices.find(
          (device) => device.deviceIndex === index,
        )?.port;
        if (connectedPort) next[index] = connectedPort;
        else if (!next[index] && sumpPorts[index - 1]) next[index] = sumpPorts[index - 1].path;
      }
      savePortBySlot(next);
      return next;
    });
  }
  function chooseSlotPort(index: DeviceIndex, port: string): void {
    const next = { ...portBySlot, [index]: port };
    setPortBySlot(next);
    savePortBySlot(next);
  }
  async function connectSlot(index: DeviceIndex): Promise<void> {
    const port = portBySlot[index]
      ?? deviceList?.devices.find((device) => device.sumpId)?.path;
    if (!port) {
      setError("没有可用的 AG32 串口");
      return;
    }
    setConnectingSlot(index);
    try {
      await api.invoke("connect", { port, deviceIndex: index });
      const next = await api.invoke<AppSnapshot>("snapshot");
      setSnapshot(next);
      setAnalyzerMode(next.devices.length > 1 ? "multi" : "single");
      setNotice(`设备 ${index} 已连接：${port}，点亮 LED${index}`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setConnectingSlot(null);
    }
  }
  async function disconnectSlot(deviceId: string): Promise<void> {
    await operation(async () => {
      await api.invoke("disconnect", { deviceId });
      const next = await api.invoke<AppSnapshot>("snapshot");
      setSnapshot(next);
      if (next.devices.length < 2) setAnalyzerMode("single");
      setNotice("设备已断开");
    });
  }
  async function activateDevice(deviceId: string): Promise<void> {
    await operation(async () => {
      await api.invoke("set_active_device", { deviceId });
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setHistoryFrame(null);
    });
  }
  async function chooseDeviceIndex(next: DeviceIndex): Promise<void> {
    const previous = deviceIndex;
    setDeviceIndexState(next);
    saveDeviceIndex(selectedPort, next);
    if (!connected) return;
    setBusyCount((count) => count + 1);
    try {
      await api.invoke("set_device_index", { deviceIndex: next });
      setNotice(`设备编号已切换为 ${next}，点亮 LED${next}`);
    } catch (failure) {
      setDeviceIndexState(previous);
      saveDeviceIndex(selectedPort, previous);
      setError(errorText(failure));
    } finally {
      setBusyCount((count) => Math.max(0, count - 1));
    }
  }
  async function captureOnce(): Promise<void> {
    await captureDevice(snapshot?.activeDeviceId ?? undefined);
  }
  async function captureDevice(deviceId?: string): Promise<void> {
    if (!deviceId) return;
    await operation(async () => {
      const frame = await api.invoke<CaptureFrame>("capture", {
        deviceId,
        sampleRateHz: settings.sampleRateHz, sampleCount: settings.sampleCount,
        pretriggerPercent: settings.pretriggerPercent, trigger: buildTrigger(settings), persist: true,
      });
      setLatestCapture(frame);
      setHistoryFrame(null);
    });
  }
  async function captureSynchronized(): Promise<void> {
    if (connectedDevices.length < 2) return;
    await operation(async () => {
      const group = await api.invoke<SynchronizedCaptureGroup>("capture_synchronized", {
        deviceIds: connectedDevices.map((device) => device.deviceId),
        request: {
          sampleRateHz: settings.sampleRateHz,
          sampleCount: settings.sampleCount,
          pretriggerPercent: settings.pretriggerPercent,
          trigger: buildTrigger(settings),
          persist: true,
        },
      });
      setGroupCapture(group);
      setAnalyzerMode("group");
      setHistoryFrame(null);
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setNotice(`联合采集完成：${group.frames.length} 台，主机请求偏差 ${group.maxStartSkewMs.toFixed(1)} ms`);
    });
  }
  async function toggleRepeat(): Promise<void> {
    await toggleRepeatForDevice(snapshot?.activeDeviceId ?? undefined);
  }
  async function toggleRepeatForDevice(deviceId?: string): Promise<void> {
    if (!deviceId) return;
    await operation(async () => {
      if (repeatsByDevice.get(deviceId)?.active) await api.invoke("stop_repeat", { deviceId });
      else await api.invoke("start_repeat", {
        deviceId,
        fps: settings.repeatFps,
        request: { sampleRateHz: settings.sampleRateHz, sampleCount: settings.sampleCount,
          pretriggerPercent: settings.pretriggerPercent, trigger: buildTrigger(settings) },
      });
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
    });
  }
  async function safeIdle(): Promise<void> {
    await operation(async () => {
      if (connectedDevices.length > 1) await api.invoke("safe_idle_all");
      else await api.invoke("safe_idle", { deviceId: snapshot?.activeDeviceId });
      setNotice("PIN_11 已关闭，PIN_5 已停止翻转并输出低电平");
    });
  }
  async function refreshHistory(): Promise<void> {
    setHistoryLoading(true);
    try {
      const [records, usage] = await Promise.all([
        api.invoke<HistoryRecord[]>("history_list"), api.invoke<StorageUsage>("storage_usage"),
      ]);
      setHistoryRecords(records);
      setSnapshot((current) => current ? { ...current, storage: usage } : current);
    } catch (failure) { setError(errorText(failure)); }
    finally { setHistoryLoading(false); }
  }
  async function loadHistory(record: HistoryRecord): Promise<void> {
    await operation(async () => {
      const frame = await api.invoke<CaptureFrame>("history_load", { id: record.id });
      setHistoryFrame(frame);
      setAnalyzerMode("single");
      setView("analyzer");
    });
  }
  async function favoriteHistory(record: HistoryRecord, favorite: boolean): Promise<void> {
    await operation(async () => {
      await api.invoke("history_favorite", { id: record.id, favorite }); await refreshHistory();
    });
  }
  async function deleteHistory(record: HistoryRecord): Promise<void> {
    await operation(async () => { await api.invoke("history_delete", { id: record.id }); await refreshHistory(); });
  }
  function openPath(target: string, reveal = false): void {
    void api.openPath?.(target, reveal).then((result) => { if (result) setError(result); })
      .catch((failure) => setError(errorText(failure)));
  }
  async function operation(work: () => Promise<unknown>): Promise<void> {
    setBusyCount((count) => count + 1);
    try { await work(); } catch (failure) { setError(errorText(failure)); }
    finally { setBusyCount((count) => Math.max(0, count - 1)); }
  }
  function updateSettings(recipe: (current: AppSettings) => AppSettings): void {
    setSettings((current) => recipe(current));
  }
  function updateOutputDraft(
    deviceId: string,
    recipe: (current: OutputDraft) => OutputDraft,
  ): void {
    setOutputDrafts((current) => ({
      ...current,
      [deviceId]: recipe(
        current[deviceId]
          ?? createOutputDraft(
            settings,
            connectedDevices.find((device) => device.deviceId === deviceId) ?? EMPTY_DEVICE,
          ),
      ),
    }));
  }
  function reloadOutputFromDevice(deviceId: string): void {
    const device = connectedDevices.find((item) => item.deviceId === deviceId);
    if (!device) return;
    const next = createOutputDraft(settings, device);
    setOutputDrafts((current) => ({ ...current, [deviceId]: next }));
    setOutputSubmitted((current) => ({
      ...current,
      [deviceId]: cloneOutputDraft(next),
    }));
    setOutputBaselines((current) => ({
      ...current,
      [deviceId]: deviceOutputBaseline(device),
    }));
    setNotice(`已载入 ${device.alias} 的当前硬件状态`);
  }
  async function runOutputCommand(
    deviceId: string,
    method: DaemonMethod,
    params: Record<string, unknown>,
    commit?: (
      draft: OutputDraft,
      submitted: OutputDraft,
    ) => { draft: OutputDraft; submitted: OutputDraft },
    successMessage = "输出参数已应用",
  ): Promise<void> {
    await operation(async () => {
      const device = await api.invoke<DeviceState>(method, { ...params, deviceId });
      if (commit) {
        const baseDraft = outputDrafts[deviceId] ?? createOutputDraft(settings, device);
        const baseSubmitted = outputSubmitted[deviceId] ?? cloneOutputDraft(baseDraft);
        const result = commit(
          cloneOutputDraft(baseDraft),
          cloneOutputDraft(baseSubmitted),
        );
        setOutputDrafts((current) => ({ ...current, [deviceId]: result.draft }));
        setOutputSubmitted((current) => ({
          ...current,
          [deviceId]: result.submitted,
        }));
      }
      setSnapshot((current) => current
        ? mergeDeviceIntoSnapshot(current, device)
        : current);
      const domain = method === "configure_pin11" || method === "configure_pin11_static"
        ? "pin11"
        : "pin5";
      setOutputBaselines((current) => {
        const baseline = current[deviceId] ?? deviceOutputBaseline(device);
        return {
          ...current,
          [deviceId]: {
            ...baseline,
            [domain]: domain === "pin5"
              ? pin5HardwareFingerprint(device)
              : pin11HardwareFingerprint(device),
          },
        };
      });
      setNotice(`${device.alias} ${successMessage}`);
    });
  }
  function updateLevelChannel(channel: ChannelName, enabled: boolean, high: boolean): void {
    updateSettings((current) => {
      const channels = enabled ? [...new Set([...current.triggerChannels, channel])]
        : current.triggerChannels.filter((item) => item !== channel);
      const highs = enabled && high ? [...new Set([...current.highChannels, channel])]
        : current.highChannels.filter((item) => item !== channel);
      return { ...current, triggerChannels: channels.length > 0 ? channels : [channel], highChannels: highs };
    });
  }
  function updateEdgeChannel(channel: ChannelName, direction: string): void {
    updateSettings((current) => ({
      ...current,
      edges: direction === "off" ? current.edges.filter((item) => item.channel !== channel)
        : [...current.edges.filter((item) => item.channel !== channel), {
          channel, direction: direction as "rising" | "falling",
        }],
    }));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block"><div className="brand-mark"><AudioWaveform size={25} strokeWidth={2.2} /></div>
          <div><strong>AG32 Logic</strong><span>STUDIO</span></div></div>
        <nav className="side-nav" aria-label="工作区"><span className="nav-caption">工作台</span>
          <button aria-label="波形分析" className={view === "analyzer" ? "active" : ""} onClick={() => setView("analyzer")}>
            <SquareActivity size={19} /><span>波形分析</span><ChevronRight size={15} /></button>
          <button aria-label="信号输出" className={view === "outputs" ? "active" : ""} onClick={() => setView("outputs")}>
            <Radio size={19} /><span>信号输出</span><ChevronRight size={15} /></button>
          <button aria-label="历史记录" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
            <FolderClock size={19} /><span>历史记录</span><ChevronRight size={15} /></button>
        </nav>
        <div className="sidebar-bottom"><div className="mcp-status"><span className={mcpClient ? "online" : ""}><Cpu size={16} /></span>
          <div><strong>MCP 服务</strong><small>{mcpClient ? "已连接，可协同调试" : "等待客户端连接"}</small></div></div>
          <button className="idle-button" onClick={() => void safeIdle()} disabled={!connected || busy}><Power size={16} />输出安全空闲</button>
          <span className="version-label">AG32 LOGIC STUDIO · V0.2</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="page-title">
          <span>{view === "analyzer" ? "实时调试" : view === "outputs" ? "设备控制" : "采集档案"}</span>
          <h1>{view === "analyzer" ? "逻辑分析仪" : view === "outputs" ? "信号发生器" : "历史记录"}</h1></div>
          <div className="topbar-actions">{isMockMode && <span className="preview-badge">预览模式</span>}
            <div className={connected ? "connection-state online" : "connection-state"}><i />{connected ? `${connectedDevices.length} / 4 台已连接` : "设备未连接"}</div>
            <div className="port-control"><Usb size={16} />
              <select className="port-select" aria-label="设备串口" value={selectedPort} onChange={(event) => choosePort(event.target.value)} disabled={connected}>
                {(deviceList?.devices.length ? deviceList.devices : [{ path: selectedPort }]).map((device) => (
                  <option key={device.path} value={device.path}>{device.path}{device.sumpId ? " · AG32" : ""}</option>))}
              </select>
              <select className="device-index-select" aria-label="设备编号" title="设备编号决定常亮 LED" value={deviceIndex} onChange={(event) => void chooseDeviceIndex(Number(event.target.value) as DeviceIndex)}>
                {([1, 2, 3, 4] as DeviceIndex[]).map((index) => <option key={index} value={index}>#{index}</option>)}
              </select>
              <button className="icon-button" title="重新扫描串口" onClick={() => void scanDevices()} disabled={scanning || connected}>
                <RefreshCw size={15} className={scanning ? "spin" : ""} /></button></div>
            <button className={connected ? "secondary-button" : "primary-button"} onClick={() => void (connected ? disconnect() : connect())} disabled={busy || !selectedPort}>
              {connected ? "断开连接" : "连接设备"}</button>
          </div>
        </header>
        {view === "analyzer" && <main className="analyzer-workspace">
          <section className="device-rack" aria-label="多设备工作区">
            <div className="device-rack-heading">
              <div><Boxes size={17} /><strong>设备工作区</strong><span>每台设备固定一个 LED 编号，最多同时连接 4 台</span></div>
              <div className="device-rack-summary"><i className={connectedDevices.length > 0 ? "online" : ""} />
                {connectedDevices.length} / 4 在线
              </div>
            </div>
            <div className="device-slot-grid">
              {([1, 2, 3, 4] as DeviceIndex[]).map((index) => {
                const device = connectedDevices.find((item) => item.deviceIndex === index);
                const active = device?.deviceId === snapshot?.activeDeviceId;
                const port = device?.port ?? portBySlot[index] ?? "";
                const deviceRepeat = device ? repeatsByDevice.get(device.deviceId) : null;
                return <article
                  className={active ? "device-slot active" : device ? "device-slot connected" : "device-slot"}
                  data-device-index={index}
                  data-device-id={device?.deviceId ?? ""}
                  key={index}
                >
                  <div className="device-slot-head">
                    <span className={`led-indicator led-${index}`} title={`设备 ${index} 点亮 LED${index}`}>
                      <i />LED{index}
                    </span>
                    <strong>{device?.alias ?? `设备 #${index}`}</strong>
                    <small>{device?.info ? `GEN v${device.info.firmware.major}.${device.info.firmware.minor}` : "未连接"}</small>
                  </div>
                  {device ? <>
                    <button className="device-slot-main" onClick={() => void activateDevice(device.deviceId)} title="设为当前设备">
                      <Cable size={15} />
                      <span><strong>{device.port}</strong><small>{device.identityStable ? "唯一序列号" : "USB 物理位置识别"}</small></span>
                    </button>
                    <div className="device-slot-actions">
                      <span className={active ? "active-device-label" : ""}>{active ? <><Link2 size={13} />当前设备</> : "点击切换"}</span>
                      {deviceRepeat?.active && <span className="device-repeat-label"><i />采集中</span>}
                      <button className="icon-button danger" title={`断开设备 #${index}`} onClick={() => void disconnectSlot(device.deviceId)} disabled={busy}>
                        <Unplug size={15} />
                      </button>
                    </div>
                  </> : <>
                    <select aria-label={`设备 ${index} 串口`} value={port} onChange={(event) => chooseSlotPort(index, event.target.value)}>
                      <option value="">选择 COM 口</option>
                      {(deviceList?.devices ?? []).filter((item) => item.sumpId).map((item) => (
                        <option key={item.path} value={item.path}>
                          {item.path}{item.firmware ? ` · ${item.firmware}` : ""}
                        </option>
                      ))}
                    </select>
                    <button className="device-connect-button" onClick={() => void connectSlot(index)} disabled={busy || !port || connectingSlot !== null}>
                      {connectingSlot === index ? <RefreshCw className="spin" size={14} /> : <Link2 size={14} />}
                      连接并点亮 LED{index}
                    </button>
                  </>}
                </article>;
              })}
            </div>
          </section>
          <section className="acquisition-toolbar" aria-label="采集参数">
            <div className="parameter-field"><label htmlFor="sample-rate">采样率</label>
              <select id="sample-rate" value={settings.sampleRateHz} onChange={(event) => updateSettings((current) => ({ ...current, sampleRateHz: Number(event.target.value) }))}>
                {sampleRateChoices().map((rate) => <option key={rate} value={rate}>{formatFrequency(rate)} Sa/s</option>)}</select></div>
            <div className="parameter-field"><label>采样深度</label><Segmented value={String(settings.sampleCount)} options={[
              { value: "1024", label: "1K" }, { value: "2048", label: "2K" },
              { value: "4096", label: "4K" }, { value: "8192", label: "8K" },
            ]} onChange={(value) => updateSettings((current) => ({ ...current, sampleCount: Number(value) }))} /></div>
            <div className="parameter-field trigger-parameter"><label>触发方式</label><Segmented value={settings.triggerMode} options={[
              { value: "immediate", label: "立即" }, { value: "level", label: "电平" }, { value: "edge", label: "边沿" },
            ]} onChange={(value) => updateSettings((current) => ({ ...current, triggerMode: value as AppSettings["triggerMode"] }))} /></div>
            <div className="pretrigger-field"><label htmlFor="pretrigger">预触发 <strong>{settings.pretriggerPercent}%</strong></label>
              <input id="pretrigger" type="range" min={0} max={90} step={5} value={settings.pretriggerPercent}
                onChange={(event) => updateSettings((current) => ({ ...current, pretriggerPercent: Number(event.target.value) }))} /></div>
            <div className="capture-controls"><button className="capture-button" disabled={!connected || busy} onClick={() => void captureOnce()}><CircleStop size={16} />采集一帧</button>
              <button className={repeatActive ? "repeat-button active" : "repeat-button"} disabled={!connected || busy} onClick={() => void toggleRepeat()}>
                {repeatActive ? <Pause size={16} /> : <Play size={16} />}{repeatActive ? "停止" : "重复采集"}</button></div>
              <button className={analyzerMode === "group" ? "sync-capture-button active" : "sync-capture-button"} disabled={connectedDevices.length < 2 || busy} onClick={() => void captureSynchronized()}>
                <GitCompareArrows size={16} />联合采集
              </button>
              <select className="fps-select" aria-label="重复采集帧率" title="重复采集帧率" value={settings.repeatFps} onChange={(event) => updateSettings((current) => ({ ...current, repeatFps: Number(event.target.value) }))}>
                {[1, 5, 10, 20, 30].map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}</select>
          </section>
          {settings.triggerMode !== "immediate" && <section className="trigger-settings">
            <div className="trigger-settings-title"><Zap size={16} /><strong>{settings.triggerMode === "level" ? "电平触发" : "边沿触发"}</strong>
              <span>{settings.triggerMode === "level" ? "所有参与通道同时满足条件" : "任一所选边沿成立即触发"}</span></div>
            <div className="trigger-channel-grid">{CHANNEL_NAMES.map((channel) => {
              if (settings.triggerMode === "level") {
                const enabled = settings.triggerChannels.includes(channel);
                const high = settings.highChannels.includes(channel);
                return <div className="trigger-channel" key={channel}><span className={`channel-badge ${channel.toLowerCase()}`}>{channel}</span>
                  <label className="check-label"><input type="checkbox" checked={enabled} onChange={(event) => updateLevelChannel(channel, event.target.checked, high)} />参与</label>
                  <Segmented compact value={high ? "high" : "low"} options={[{ value: "high", label: "高" }, { value: "low", label: "低" }]} onChange={(value) => updateLevelChannel(channel, true, value === "high")} /></div>;
              }
              const edge = settings.edges.find((item) => item.channel === channel);
              return <div className="trigger-channel" key={channel}><span className={`channel-badge ${channel.toLowerCase()}`}>{channel}</span>
                <Segmented compact value={edge?.direction ?? "off"} options={[{ value: "off", label: "关闭" }, { value: "rising", label: "上升沿" }, { value: "falling", label: "下降沿" }]} onChange={(value) => updateEdgeChannel(channel, value)} /></div>;
            })}</div>
          </section>}
          <section className="waveform-section"><div className="waveform-heading">
            <div className="waveform-heading-main">
              <div className="analyzer-view-switch" role="group" aria-label="波形显示模式">
                <button className={analyzerMode === "multi" ? "active" : ""} aria-pressed={analyzerMode === "multi"} onClick={() => {
                  setHistoryFrame(null);
                  setAnalyzerMode("multi");
                }}>
                  <Boxes size={14} />多设备
                </button>
                <button className={analyzerMode === "single" ? "active" : ""} aria-pressed={analyzerMode === "single"} onClick={() => {
                  setHistoryFrame(null);
                  setAnalyzerMode("single");
                }}>
                  <SquareActivity size={14} />单设备
                </button>
                <button className={analyzerMode === "group" ? "active" : ""} aria-pressed={analyzerMode === "group"} disabled={!groupCapture} onClick={() => {
                  setHistoryFrame(null);
                  setAnalyzerMode("group");
                }}>
                  <GitCompareArrows size={14} />联合视图
                </button>
              </div>
              <div className="channel-legend">
                {CHANNEL_NAMES.map((channel) => <label key={channel} className={`channel-toggle ${channel.toLowerCase()} ${settings.channelVisibility[channel] ? "active" : ""}`}>
                  <input type="checkbox" checked={settings.channelVisibility[channel]} onChange={(event) => updateSettings((current) => ({ ...current, channelVisibility: { ...current.channelVisibility, [channel]: event.target.checked } }))} />
                  <i /><span>{channel}</span><small>PIN_{Number(channel.slice(2)) + 6}</small></label>)}
              </div>
            </div>
            <div className="waveform-heading-actions">
              <div className={activeRepeatCount > 0 ? "capture-state live" : "capture-state"}><i />{analyzerMode === "group" && groupCapture
                ? `联合采集 · ${groupCapture.frames.length} 台`
                : historyFrame
                  ? `历史波形 · ${historyFrame.deviceAlias ?? historyFrame.deviceId?.slice(-8) ?? "未知设备"}`
                  : analyzerMode === "multi"
                    ? `${connectedDevices.length} 台并行 · ${activeRepeatCount > 0 ? `${activeRepeatCount} 台采集中` : "可独立采集"}`
                    : repeatActive
                      ? `实时采集 · ${settings.repeatFps} FPS`
                      : activeCapture
                        ? `${snapshot?.device.alias ?? "当前设备"} · ${activeCapture.source === "mcp" ? "MCP 采集帧" : "单帧视图"}`
                        : "等待采集"}</div>
            </div></div>
            {analyzerMode === "group" && groupCapture
              ? <GroupWaveformCanvas group={groupCapture} visibility={settings.channelVisibility} />
              : analyzerMode === "multi"
                ? <div className="device-waveform-grid" data-testid="device-waveform-grid">
                    {connectedDevices.map((device) => {
                      const frame = framesByDevice.get(device.deviceId) ?? null;
                      const deviceRepeat = repeatsByDevice.get(device.deviceId);
                      return <article
                        className="device-waveform-card"
                        data-testid="device-waveform"
                        data-device-id={device.deviceId}
                        data-device-index={device.deviceIndex}
                        data-frame-id={frame?.id ?? ""}
                        key={device.deviceId}
                      >
                        <header className="device-waveform-header">
                          <div>
                            <span className={`led-indicator led-${device.deviceIndex ?? 1}`}><i />LED{device.deviceIndex}</span>
                            <strong>{device.alias}</strong>
                            <small>{device.port}</small>
                            <span className={deviceRepeat?.active ? "device-live-state active" : "device-live-state"}><i />{deviceRepeat?.active ? `采集中 · ${deviceRepeat.fps} FPS` : frame ? "最新帧" : "等待采集"}</span>
                          </div>
                          <div className="device-waveform-actions">
                            <button className="icon-button bordered" title={`采集 ${device.alias}`} aria-label={`采集 ${device.alias}`} disabled={busy} onClick={() => void captureDevice(device.deviceId)}>
                              <CircleStop size={15} />
                            </button>
                            <button className={deviceRepeat?.active ? "device-repeat-button active" : "device-repeat-button"} title={`${deviceRepeat?.active ? "停止" : "开始"}重复采集 ${device.alias}`} aria-label={`${deviceRepeat?.active ? "停止" : "开始"}重复采集 ${device.alias}`} disabled={busy} onClick={() => void toggleRepeatForDevice(device.deviceId)}>
                              {deviceRepeat?.active ? <Pause size={14} /> : <Play size={14} />}{deviceRepeat?.active ? "停止" : "重复"}
                            </button>
                          </div>
                        </header>
                        <WaveformCanvas frame={frame} visibility={settings.channelVisibility} />
                      </article>;
                    })}
                  </div>
                : <WaveformCanvas frame={historyFrame ?? activeCapture} visibility={settings.channelVisibility} />}
          </section>
          <section className="measurements-section"><div className="section-title-row"><div><Activity size={17} /><h2>通道测量</h2></div>
            <span>{analyzerMode === "group" && groupCapture
              ? `联合组 ${new Date(groupCapture.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : displayFrame
                ? `${displayFrame.deviceAlias ?? snapshot?.device.alias ?? ""} · ${new Date(displayFrame.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                : "暂无数据"}</span></div>
            <div className="measurement-table-wrap"><table className="measurement-table"><thead><tr><th>通道</th><th>估算频率</th><th>边沿计数</th><th>高电平占比</th><th>首个边沿</th><th>末个边沿</th></tr></thead>
              <tbody>{displayFrame?.channels.filter((channel) => settings.channelVisibility[channel.channel]).map((channel) => <tr key={channel.channel}>
                <td><span className={`channel-badge ${channel.channel.toLowerCase()}`}>{channel.channel}</span><small>{channel.pin}</small></td>
                <td>{formatFrequency(channel.estimatedFrequencyHz)}</td><td>{channel.edgeCount.toLocaleString()}</td>
                <td>{((channel.highCount / (channel.highCount + channel.lowCount)) * 100).toFixed(1)}%</td>
                <td>{formatTime(channel.firstEdgeTimeNs)}</td><td>{formatTime(channel.lastEdgeTimeNs)}</td></tr>)}</tbody></table>
              {!displayFrame && <div className="measurement-empty"><ScanLine size={20} />采集一帧后显示通道测量结果</div>}</div>
          </section>
        </main>}
        {view === "outputs" && <main className="outputs-workspace"><div className="outputs-intro"><div><h2>两路独立信号输出</h2>
          <p>每台设备独立保存未提交参数，点击应用后才会写入对应硬件。</p></div>
          <span className={connected ? "output-device online" : "output-device"}><Radio size={15} />{connected ? `${connectedDevices.length} 台设备可独立控制` : "连接设备后可控制输出"}</span></div>
          {connectedDevices.length > 0 ? <>
            <section className="output-device-selector" aria-label="输出设备选择">
              <div className="output-device-selector-heading"><div><Boxes size={16} /><strong>设备级输出控制</strong><span>切换标签只切换本机草稿，不改变 daemon 活动设备</span></div></div>
              <div className="output-device-tabs">
                {connectedDevices.map((device) => {
                  const selected = device.deviceId === selectedOutputDevice.deviceId;
                  const hardwareChanged = deviceOutputHardwareChanged(
                    outputBaselines[device.deviceId],
                    device,
                  );
                  return <button
                    className={selected ? "output-device-tab active" : "output-device-tab"}
                    aria-label={`输出设备 ${device.alias}`}
                    aria-pressed={selected}
                    data-device-id={device.deviceId}
                    onClick={() => setOutputDeviceId(device.deviceId)}
                    key={device.deviceId}
                  >
                    <span className={`output-tab-led led-${device.deviceIndex ?? 1}`}><i /></span>
                    <span><strong>{device.alias}</strong><small>{device.port}</small></span>
                    <span className="output-tab-state">
                      {hardwareChanged ? "硬件已更新" : `PIN_5 ${device.pin5?.outputHigh ? "HIGH" : "LOW"} · PIN_11 ${device.info?.flags && device.info.flags & 1 ? "ON" : "OFF"}`}
                    </span>
                  </button>;
                })}
              </div>
            </section>
            <div className="output-draft-status">
              <span className={selectedHardwareChanged ? "changed" : selectedDraftDirty ? "pending" : "synced"}><i />
                {selectedHardwareChanged ? "硬件状态已由 MCP 或其他客户端更新"
                  : selectedDirtyDomains.length > 0 ? `未提交：${selectedDirtyDomains.join("、")}`
                    : "当前设备草稿与已应用参数一致"}
              </span>
              <small>{selectedOutputDevice.alias} · {selectedOutputDevice.port} · 草稿仅作用于此设备</small>
            </div>
            <SignalSources
              key={selectedOutputDevice.deviceId}
              draft={selectedOutputDraft}
              device={selectedOutputDevice}
              disabled={busy || !selectedOutputDevice.connected}
              hardwareChanged={selectedHardwareChanged}
              draftDirty={selectedDraftDirty}
              pin5Dirty={selectedPin5Dirty}
              pin11Dirty={selectedPin11Dirty}
              updateDraft={(recipe) => updateOutputDraft(selectedOutputDevice.deviceId, recipe)}
              onReloadHardware={() => reloadOutputFromDevice(selectedOutputDevice.deviceId)}
              configurePin5Square={(frequencyHz) => void runOutputCommand(
                selectedOutputDevice.deviceId,
                "configure_pin5_square",
                { frequencyHz },
                (draft, submitted) => ({
                  draft: {
                    ...draft,
                    pin5: { ...draft.pin5, source: "square", squareFrequencyHz: frequencyHz },
                  },
                  submitted: {
                    ...submitted,
                    pin5: { ...submitted.pin5, source: "square", squareFrequencyHz: frequencyHz },
                  },
                }),
                "PIN_5 方波已应用",
              )}
              configurePin5Engine={(config: Pin5EngineConfig) => {
                const engine = { ...config, action: undefined };
                void runOutputCommand(
                  selectedOutputDevice.deviceId,
                  "configure_pin5_engine",
                  { ...engine },
                  (draft, submitted) => ({
                    draft: {
                      ...draft,
                      pin5: { ...draft.pin5, source: "engine", engine },
                    },
                    submitted: {
                      ...submitted,
                      pin5: { ...submitted.pin5, source: "engine", engine },
                    },
                  }),
                  "PIN_5 引擎配置已应用",
                );
              }}
              controlPin5Engine={(action) => void runOutputCommand(
                selectedOutputDevice.deviceId,
                "pin5_engine_control",
                { action },
                undefined,
                action === "arm" ? "PIN_5 引擎已布防"
                  : action === "fire" ? "PIN_5 引擎已触发"
                    : "PIN_5 引擎已复位",
              )}
              configurePin11={(config: Pin11Config) => void runOutputCommand(
                selectedOutputDevice.deviceId,
                "configure_pin11",
                { ...config },
                (draft, submitted) => ({
                  draft: {
                    ...draft,
                    pin11: { ...config, mode: "waveform" },
                  },
                  submitted: {
                    ...submitted,
                    pin11: { ...config, mode: "waveform" },
                  },
                }),
                "PIN_11 波形已应用",
              )}
              configurePin11Static={(mode) => {
                const outputMode: Pin11OutputMode = mode === 1
                  ? "low"
                  : mode === 2
                    ? "high"
                    : "off";
                void runOutputCommand(
                  selectedOutputDevice.deviceId,
                  "configure_pin11_static",
                  { mode },
                  (draft, submitted) => ({
                    draft: {
                      ...draft,
                      pin11: { ...draft.pin11, enabled: false, mode: outputMode },
                    },
                    submitted: {
                      ...submitted,
                      pin11: { ...submitted.pin11, enabled: false, mode: outputMode },
                    },
                  }),
                  "PIN_11 静态输出已应用",
                );
              }}
            />
          </> : <div className="output-empty"><Radio size={24} /><strong>尚未连接设备</strong><span>连接设备后可分别配置 PIN_5 与 PIN_11。</span></div>}
          <div className="output-footnote"><Check size={15} />退出上位机不会改变当前硬件输出状态；外部状态变化不会自动覆盖本机草稿。</div></main>}
        {view === "history" && <main className="history-main"><HistoryView records={historyRecords} usage={storage} loading={historyLoading} busy={busy}
          onRefresh={() => void refreshHistory()} onLoad={(record) => void loadHistory(record)}
          onFavorite={(record, favorite) => void favoriteHistory(record, favorite)} onDelete={(record) => void deleteHistory(record)} onOpen={openPath} /></main>}
        <footer className="statusbar"><span className={connected ? "footer-status online" : "footer-status"}><i />{connected ? `${connectedDevices.length} 台 USB CDC 已就绪` : "USB CDC 离线"}</span>
          <span><Gauge size={13} />{displayFrame ? formatFrequency(displayFrame.actualSampleRateHz) : "--"}</span>
          <span><Clock3 size={13} />{displayFrame ? formatTime((displayFrame.sampleCount / displayFrame.actualSampleRateHz) * 1e9) : "--"}</span>
          <span><Database size={13} />{displayFrame?.sampleCount.toLocaleString() ?? "--"} 点</span>
          <span className="footer-spacer" /><span><HardDrive size={13} />缓存 {formatBytes(storage?.totalBytes ?? 0)}</span>
          <span className="footer-message">{error ?? notice ?? snapshot?.activity[0]?.label ?? "系统就绪"}<ArrowUpRight size={12} /></span></footer>
      </div>
      {(error || notice) && <div className={error ? "toast error" : "toast"}>{error ? <AlertTriangle size={19} /> : <Check size={19} />}
        <div><strong>{error ? "操作失败" : "操作完成"}</strong><span>{error ?? notice}</span></div>
        <button className="icon-button" title="关闭提示" onClick={() => { setError(null); setNotice(null); }}><X size={16} /></button></div>}
    </div>
  );
}

function buildTrigger(settings: AppSettings) {
  if (settings.triggerMode === "level") return { mode: "level" as const, channels: settings.triggerChannels, highChannels: settings.highChannels };
  if (settings.triggerMode === "edge") return { mode: "edge" as const, edges: settings.edges };
  return { mode: "immediate" as const };
}
function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function pin5HardwareFingerprint(device: DeviceState): string {
  return JSON.stringify(device.pin5);
}

function pin11HardwareFingerprint(device: DeviceState): string {
  return JSON.stringify({
    pin11Static: device.pin11Static,
    info: device.info
      ? {
          waveform: device.info.waveform,
          amplitudePercent: device.info.amplitudePercent,
          requestedFrequencyHz: device.info.requestedFrequencyHz,
          actualFrequencyHz: device.info.actualFrequencyHz,
          flags: device.info.flags,
          rateCapHz: device.info.rateCapHz,
        }
      : null,
  });
}

function deviceOutputBaseline(device: DeviceState): DeviceOutputBaseline {
  return {
    pin5: pin5HardwareFingerprint(device),
    pin11: pin11HardwareFingerprint(device),
  };
}

function deviceOutputHardwareChanged(
  baseline: DeviceOutputBaseline | undefined,
  device: DeviceState,
): boolean {
  return Boolean(baseline)
    && (baseline!.pin5 !== pin5HardwareFingerprint(device)
      || baseline!.pin11 !== pin11HardwareFingerprint(device));
}

function mergeDeviceIntoSnapshot(snapshot: AppSnapshot, state: DeviceState): AppSnapshot {
  const devices = snapshot.devices.some((device) => device.deviceId === state.deviceId)
    ? snapshot.devices.map((device) => device.deviceId === state.deviceId ? state : device)
    : [...snapshot.devices, state];
  const activeDeviceId = devices.some((device) => device.deviceId === snapshot.activeDeviceId)
    ? snapshot.activeDeviceId
    : devices[0]?.deviceId ?? null;
  return {
    ...snapshot,
    devices,
    activeDeviceId,
    device: devices.find((device) => device.deviceId === activeDeviceId) ?? EMPTY_DEVICE,
  };
}

function savedDeviceIndex(port: string): DeviceIndex {
  try {
    const mapping = JSON.parse(window.localStorage.getItem(DEVICE_INDEX_BY_PORT_KEY) ?? "{}") as Record<string, unknown>;
    const value = Number(mapping[port]);
    return value >= 1 && value <= 4 ? value as DeviceIndex : 1;
  } catch {
    return 1;
  }
}

function saveDeviceIndex(port: string, index: DeviceIndex): void {
  try {
    const mapping = JSON.parse(window.localStorage.getItem(DEVICE_INDEX_BY_PORT_KEY) ?? "{}") as Record<string, unknown>;
    mapping[port] = index;
    window.localStorage.setItem(DEVICE_INDEX_BY_PORT_KEY, JSON.stringify(mapping));
  } catch {
    // Storage failure must not prevent changing the physical LED identity.
  }
}

function loadPortBySlot(): Record<DeviceIndex, string> {
  const empty = { 1: "", 2: "", 3: "", 4: "" } as Record<DeviceIndex, string>;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PORT_BY_DEVICE_SLOT_KEY) ?? "{}",
    ) as Record<string, unknown>;
    for (const index of [1, 2, 3, 4] as DeviceIndex[]) {
      if (typeof parsed[index] === "string") empty[index] = parsed[index] as string;
    }
  } catch {
    // A corrupt local preference only affects convenience defaults.
  }
  return empty;
}

function savePortBySlot(value: Record<DeviceIndex, string>): void {
  try {
    window.localStorage.setItem(PORT_BY_DEVICE_SLOT_KEY, JSON.stringify(value));
  } catch {
    // Port persistence is optional.
  }
}
