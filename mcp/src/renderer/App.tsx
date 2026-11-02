import { useEffect, useRef, useState } from "react";
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
import type {
  AppSettings, AppSnapshot, CaptureFrame, ChannelName, DaemonEvent,
  DeviceListResult, HistoryRecord, Pin11Config, Pin5EngineConfig, StorageUsage,
  SynchronizedCaptureGroup,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

type ViewName = "analyzer" | "outputs" | "history";
type DeviceIndex = 1 | 2 | 3 | 4;
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
  const [groupView, setGroupView] = useState(false);
  const [view, setView] = useState<ViewName>("analyzer");
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const eventRef = useRef<(event: DaemonEvent) => void>(() => undefined);
  const busy = busyCount > 0;
  const connected = Boolean(snapshot?.device.connected);
  const connectedDevices = snapshot?.devices ?? [];
  const mcpClient = snapshot?.clients.find((client) => client.role === "mcp");
  const repeatActive = Boolean(snapshot?.repeat.active);
  const storage = snapshot?.storage ?? null;
  const activeCapture = snapshot?.latestCaptures.find(
    (frame) => frame.deviceId === snapshot.activeDeviceId,
  ) ?? (latestCapture?.deviceId === snapshot?.activeDeviceId ? latestCapture : null);

  useEffect(() => {
    eventRef.current = (event: DaemonEvent) => {
      if (event.event === "capture") {
        const frame = event.data as CaptureFrame;
        setLatestCapture(frame);
        setNotice(frame.source === "mcp" ? "已接收 MCP 采集帧" : null);
      } else if (event.event === "group_capture") {
        const group = event.data as SynchronizedCaptureGroup;
        setGroupCapture(group);
        setGroupView(true);
        setNotice(`联合采集完成：${group.frames.length} 台设备，启动偏差 ${group.maxStartSkewMs.toFixed(1)} ms`);
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
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setNotice(`已连接 ${selectedPort}，设备 ${deviceIndex} 点亮 LED${deviceIndex}`);
    });
  }
  async function disconnect(): Promise<void> {
    await operation(async () => {
      await api.invoke("disconnect", { deviceId: snapshot?.activeDeviceId });
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
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
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
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
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setNotice("设备已断开");
    });
  }
  async function activateDevice(deviceId: string): Promise<void> {
    await operation(async () => {
      await api.invoke("set_active_device", { deviceId });
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setGroupView(false);
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
    await operation(async () => {
      setGroupView(false);
      setLatestCapture(await api.invoke<CaptureFrame>("capture", {
        deviceId: snapshot?.activeDeviceId ?? undefined,
        sampleRateHz: settings.sampleRateHz, sampleCount: settings.sampleCount,
        pretriggerPercent: settings.pretriggerPercent, trigger: buildTrigger(settings), persist: true,
      }));
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
      setGroupView(true);
      setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      setNotice(`联合采集完成：${group.frames.length} 台，软件启动偏差 ${group.maxStartSkewMs.toFixed(1)} ms`);
    });
  }
  async function toggleRepeat(): Promise<void> {
    await operation(async () => {
      if (repeatActive) await api.invoke("stop_repeat");
      else await api.invoke("start_repeat", {
        deviceId: snapshot?.activeDeviceId ?? undefined,
        fps: settings.repeatFps,
        request: { sampleRateHz: settings.sampleRateHz, sampleCount: settings.sampleCount,
          pretriggerPercent: settings.pretriggerPercent, trigger: buildTrigger(settings) },
      });
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
      setLatestCapture(await api.invoke<CaptureFrame>("history_load", { id: record.id }));
      if (record.deviceId && snapshot?.devices.some((device) => device.deviceId === record.deviceId)) {
        await api.invoke("set_active_device", { deviceId: record.deviceId });
        setSnapshot(await api.invoke<AppSnapshot>("snapshot"));
      }
      setGroupView(false);
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
                return <article className={active ? "device-slot active" : device ? "device-slot connected" : "device-slot"} key={index}>
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
              <button className={groupView ? "sync-capture-button active" : "sync-capture-button"} disabled={connectedDevices.length < 2 || busy} onClick={() => void captureSynchronized()}>
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
          <section className="waveform-section"><div className="waveform-heading"><div className="channel-legend">
            {CHANNEL_NAMES.map((channel) => <label key={channel} className={`channel-toggle ${channel.toLowerCase()} ${settings.channelVisibility[channel] ? "active" : ""}`}>
              <input type="checkbox" checked={settings.channelVisibility[channel]} onChange={(event) => updateSettings((current) => ({ ...current, channelVisibility: { ...current.channelVisibility, [channel]: event.target.checked } }))} />
              <i /><span>{channel}</span><small>PIN_{Number(channel.slice(2)) + 6}</small></label>)}</div>
            <div className="waveform-heading-actions">
              {groupCapture && <button className={groupView ? "view-toggle active" : "view-toggle"} onClick={() => setGroupView((current) => !current)}>
                <GitCompareArrows size={14} />{groupView ? "退出联合视图" : "查看联合视图"}
              </button>}
              <div className={repeatActive ? "capture-state live" : "capture-state"}><i />{groupView && groupCapture
                ? `联合采集 · ${groupCapture.frames.length} 台`
                : repeatActive
                  ? `实时采集 · ${settings.repeatFps} FPS`
                  : activeCapture
                    ? `${snapshot?.device.alias ?? "当前设备"} · ${activeCapture.source === "mcp" ? "MCP 采集帧" : "单帧视图"}`
                    : "等待采集"}</div>
            </div></div>
            {groupView && groupCapture
              ? <GroupWaveformCanvas group={groupCapture} visibility={settings.channelVisibility} />
              : <WaveformCanvas frame={activeCapture} visibility={settings.channelVisibility} />}</section>
          <section className="measurements-section"><div className="section-title-row"><div><Activity size={17} /><h2>通道测量</h2></div>
            <span>{groupView && groupCapture
              ? `联合组 ${new Date(groupCapture.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : activeCapture
                ? `${snapshot?.device.alias ?? ""} · ${new Date(activeCapture.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                : "暂无数据"}</span></div>
            <div className="measurement-table-wrap"><table className="measurement-table"><thead><tr><th>通道</th><th>估算频率</th><th>边沿计数</th><th>高电平占比</th><th>首个边沿</th><th>末个边沿</th></tr></thead>
              <tbody>{activeCapture?.channels.filter((channel) => settings.channelVisibility[channel.channel]).map((channel) => <tr key={channel.channel}>
                <td><span className={`channel-badge ${channel.channel.toLowerCase()}`}>{channel.channel}</span><small>{channel.pin}</small></td>
                <td>{formatFrequency(channel.estimatedFrequencyHz)}</td><td>{channel.edgeCount.toLocaleString()}</td>
                <td>{((channel.highCount / (channel.highCount + channel.lowCount)) * 100).toFixed(1)}%</td>
                <td>{formatTime(channel.firstEdgeTimeNs)}</td><td>{formatTime(channel.lastEdgeTimeNs)}</td></tr>)}</tbody></table>
              {!activeCapture && <div className="measurement-empty"><ScanLine size={20} />采集一帧后显示通道测量结果</div>}</div>
          </section>
        </main>}
        {view === "outputs" && <main className="outputs-workspace"><div className="outputs-intro"><div><h2>两路独立信号输出</h2>
          <p>配置数字激励与模拟波形，参数仅在点击应用后写入设备。</p></div>
          <span className={connected ? "output-device online" : "output-device"}><Radio size={15} />{connected ? `${snapshot?.device.alias} · ${snapshot?.device.port}` : "连接设备后可控制输出"}</span></div>
          <SignalSources settings={settings} device={snapshot?.device ?? EMPTY_DEVICE} disabled={!connected || busy} updateSettings={updateSettings}
            configurePin5Square={(frequencyHz) => void operation(() => api.invoke("configure_pin5_square", { deviceId: snapshot?.activeDeviceId, frequencyHz }))}
            configurePin5Engine={(config: Pin5EngineConfig) => void operation(() => api.invoke("configure_pin5_engine", { ...config, deviceId: snapshot?.activeDeviceId }))}
            configurePin11={(config: Pin11Config) => void operation(() => api.invoke("configure_pin11", { ...config, deviceId: snapshot?.activeDeviceId }))}
            configurePin11Static={(mode) => void operation(() => api.invoke("configure_pin11_static", { mode, deviceId: snapshot?.activeDeviceId }))} />
          <div className="output-footnote"><Check size={15} />退出上位机不会改变当前硬件输出状态。</div></main>}
        {view === "history" && <main className="history-main"><HistoryView records={historyRecords} usage={storage} loading={historyLoading} busy={busy}
          onRefresh={() => void refreshHistory()} onLoad={(record) => void loadHistory(record)}
          onFavorite={(record, favorite) => void favoriteHistory(record, favorite)} onDelete={(record) => void deleteHistory(record)} onOpen={openPath} /></main>}
        <footer className="statusbar"><span className={connected ? "footer-status online" : "footer-status"}><i />{connected ? `${connectedDevices.length} 台 USB CDC 已就绪` : "USB CDC 离线"}</span>
          <span><Gauge size={13} />{activeCapture ? formatFrequency(activeCapture.actualSampleRateHz) : "--"}</span>
          <span><Clock3 size={13} />{activeCapture ? formatTime((activeCapture.sampleCount / activeCapture.actualSampleRateHz) * 1e9) : "--"}</span>
          <span><Database size={13} />{activeCapture?.sampleCount.toLocaleString() ?? "--"} 点</span>
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
