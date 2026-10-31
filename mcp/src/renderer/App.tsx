import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CircleStop,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  History,
  Pause,
  Play,
  Power,
  Radio,
  RefreshCw,
  ScanLine,
  Settings2,
  Sparkles,
  Usb,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { api, isMockMode } from "./api.js";
import { WaveformCanvas } from "./components/WaveformCanvas.js";
import { Segmented, SignalSources } from "./components/SignalSources.js";
import { HistoryView } from "./components/HistoryView.js";
import { formatBytes, formatFrequency, formatTime, sampleRateChoices } from "./format.js";
import type {
  AppSettings,
  AppSnapshot,
  CaptureFrame,
  CaptureTrigger,
  ChannelName,
  DaemonEvent,
  DeviceListResult,
  HistoryRecord,
  Pin11Config,
  Pin5EngineConfig,
  StorageUsage,
} from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

type ViewName = "analyzer" | "history";

const CHANNEL_NAMES: ChannelName[] = ["CH1", "CH2", "CH3", "CH4"];

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [latestCapture, setLatestCapture] = useState<CaptureFrame | null>(null);
  const [deviceList, setDeviceList] = useState<DeviceListResult | null>(null);
  const [selectedPort, setSelectedPort] = useState("COM33");
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
  const mcpClient = snapshot?.clients.find((client) => client.role === "mcp");
  const repeatActive = Boolean(snapshot?.repeat.active);
  const storage: StorageUsage | null = snapshot?.storage ?? null;

  useEffect(() => {
    eventRef.current = (event: DaemonEvent) => {
      if (event.event === "capture") {
        const frame = event.data as CaptureFrame;
        setLatestCapture(frame);
        setNotice(frame.source === "mcp" ? "已接收 MCP 采集帧" : null);
        return;
      }
      if (event.event === "snapshot") {
        const next = event.data as AppSnapshot;
        setSnapshot(next);
        if (next.latestCapture) setLatestCapture(next.latestCapture);
        return;
      }
      if (event.event === "device") {
        setSnapshot((current) => current ? { ...current, device: event.data as AppSnapshot["device"] } : current);
        return;
      }
      if (event.event === "activity") {
        const item = event.data as AppSnapshot["activity"][number];
        setSnapshot((current) => current
          ? {
              ...current,
              activity: [item, ...current.activity.filter((entry) => entry.id !== item.id)].slice(0, 20),
            }
          : current);
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
    if (view === "history") void refreshHistory();
  }, [view]);

  async function bootstrap(): Promise<void> {
    try {
      const [initialSnapshot, savedSettings] = await Promise.all([
        api.invoke<AppSnapshot>("snapshot"),
        api.invoke<AppSettings>("get_settings"),
      ]);
      setSnapshot(initialSnapshot);
      setLatestCapture(initialSnapshot.latestCapture);
      setSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
      setSettingsLoaded(true);
      await scanDevices();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function scanDevices(): Promise<void> {
    setScanning(true);
    try {
      const result = await api.invoke<DeviceListResult>("list_devices");
      setDeviceList(result);
      const nextPort = result.selected
        ?? result.devices.find((device) => device.sumpId)?.path
        ?? result.devices[0]?.path
        ?? selectedPort;
      if (nextPort) setSelectedPort(nextPort);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setScanning(false);
    }
  }

  async function connect(): Promise<void> {
    await operation("连接设备", async () => {
      await api.invoke("connect", { port: selectedPort });
      const next = await api.invoke<AppSnapshot>("snapshot");
      setSnapshot(next);
      setNotice(`已连接 ${selectedPort}`);
    });
  }

  async function disconnect(): Promise<void> {
    await operation("断开设备", async () => {
      await api.invoke("disconnect");
      setNotice("设备已断开");
    });
  }

  async function captureOnce(): Promise<void> {
    await operation("采集波形", async () => {
      const frame = await api.invoke<CaptureFrame>("capture", {
        sampleRateHz: settings.sampleRateHz,
        sampleCount: settings.sampleCount,
        pretriggerPercent: settings.pretriggerPercent,
        trigger: buildTrigger(settings),
        persist: true,
      });
      setLatestCapture(frame);
    });
  }

  async function toggleRepeat(): Promise<void> {
    await operation(repeatActive ? "停止重复采集" : "启动重复采集", async () => {
      if (repeatActive) {
        await api.invoke("stop_repeat");
      } else {
        await api.invoke("start_repeat", {
          fps: settings.repeatFps,
          request: {
            sampleRateHz: settings.sampleRateHz,
            sampleCount: settings.sampleCount,
            pretriggerPercent: settings.pretriggerPercent,
            trigger: buildTrigger(settings),
          },
        });
      }
    });
  }

  async function configurePin5Square(frequencyHz: number): Promise<void> {
    await operation("设置 PIN_5 方波", () => api.invoke("configure_pin5_square", { frequencyHz }));
  }

  async function configurePin5Engine(config: Pin5EngineConfig): Promise<void> {
    await operation(`设置 PIN_5 引擎`, () => api.invoke("configure_pin5_engine", config));
  }

  async function configurePin11(config: Pin11Config): Promise<void> {
    await operation("设置 PIN_11", () => api.invoke("configure_pin11", config));
  }

  async function configurePin11Static(mode: 0 | 1 | 2): Promise<void> {
    await operation("设置 PIN_11 静态输出", () => api.invoke("configure_pin11_static", { mode }));
  }

  async function safeIdle(): Promise<void> {
    await operation("切换安全空闲", async () => {
      await api.invoke("safe_idle");
      setNotice("PIN_11 已关闭，PIN_5 已停止翻转并输出低电平");
    });
  }

  async function refreshHistory(): Promise<void> {
    setHistoryLoading(true);
    try {
      const [records, usage] = await Promise.all([
        api.invoke<HistoryRecord[]>("history_list"),
        api.invoke<StorageUsage>("storage_usage"),
      ]);
      setHistoryRecords(records);
      setSnapshot((current) => current ? { ...current, storage: usage } : current);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadHistory(record: HistoryRecord): Promise<void> {
    await operation("打开历史采集", async () => {
      const frame = await api.invoke<CaptureFrame>("history_load", { id: record.id });
      setLatestCapture(frame);
      setView("analyzer");
    });
  }

  async function favoriteHistory(record: HistoryRecord, favorite: boolean): Promise<void> {
    await operation(favorite ? "收藏记录" : "取消收藏", async () => {
      await api.invoke("history_favorite", { id: record.id, favorite });
      await refreshHistory();
    });
  }

  async function deleteHistory(record: HistoryRecord): Promise<void> {
    await operation("删除历史记录", async () => {
      await api.invoke("history_delete", { id: record.id });
      await refreshHistory();
    });
  }

  function openPath(target: string, reveal = false): void {
    void api.openPath?.(target, reveal).then((result) => {
      if (result) setError(result);
    }).catch((failure) => setError(errorText(failure)));
  }

  async function operation(_label: string, work: () => Promise<unknown>): Promise<void> {
    setBusyCount((count) => count + 1);
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusyCount((count) => Math.max(0, count - 1));
    }
  }

  function updateSettings(recipe: (current: AppSettings) => AppSettings): void {
    setSettings((current) => recipe(current));
  }

  function setChannelVisible(channel: ChannelName, visible: boolean): void {
    updateSettings((current) => ({
      ...current,
      channelVisibility: { ...current.channelVisibility, [channel]: visible },
    }));
  }

  const activeMeasurementChannels = useMemo(
    () => latestCapture?.channels.filter((channel) => settings.channelVisibility[channel.channel]) ?? [],
    [latestCapture, settings.channelVisibility],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Waves size={22} /></div>
          <div>
            <strong>AG32 Logic Studio</strong>
            <span>4 CHANNEL LOGIC ANALYZER</span>
          </div>
        </div>

        <nav className="view-tabs" aria-label="工作区">
          <button className={view === "analyzer" ? "active" : ""} onClick={() => setView("analyzer")}>
            <Activity size={15} /> 波形分析
          </button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
            <History size={15} /> 历史记录
          </button>
        </nav>

        <div className="connection-cluster">
          {isMockMode && <span className="preview-badge"><Sparkles size={13} /> 界面预览</span>}
          {mcpClient && <span className="mcp-badge"><Cpu size={13} /> MCP 在线</span>}
          <div className={connected ? "device-indicator online" : "device-indicator"}>
            <span className="device-dot" />
            <div>
              <strong>{connected ? selectedPort : "未连接"}</strong>
              <span>{connected ? firmwareLabel(snapshot) : "USB CDC · SUMP 1ALS"}</span>
            </div>
          </div>
          <div className="port-control">
            <select value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)} disabled={connected}>
              {(deviceList?.devices.length ? deviceList.devices : [{ path: selectedPort }]).map((device) => (
                <option key={device.path} value={device.path}>
                  {device.path}{device.sumpId ? " · AG32" : device.error ? " · 不可用" : ""}
                </option>
              ))}
            </select>
            <button className="icon-button" title="重新扫描串口" onClick={() => void scanDevices()} disabled={scanning || connected}>
              <RefreshCw size={15} className={scanning ? "spin" : ""} />
            </button>
          </div>
          <button
            className={connected ? "secondary-button compact" : "primary-button compact"}
            onClick={() => void (connected ? disconnect() : connect())}
            disabled={busy || !selectedPort}
          >
            <Usb size={15} />
            {connected ? "断开" : "连接"}
          </button>
          <button className="danger-action" onClick={() => void safeIdle()} disabled={!connected || busy} title="PIN_11 关闭，PIN_5 输出低电平">
            <Power size={16} />
            安全空闲
          </button>
        </div>
      </header>

      {view === "analyzer" ? (
        <main className="workspace">
          <aside className="acquisition-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">采集控制</span>
                <h1>采样与触发</h1>
              </div>
              <span className={repeatActive ? "live-pill active" : "live-pill"}>
                <span />
                {repeatActive ? "LIVE" : "STOP"}
              </span>
            </div>

            <section className="control-section flush">
              <Field label="采样率">
                <select
                  className="full-select"
                  value={settings.sampleRateHz}
                  onChange={(event) => updateSettings((current) => ({ ...current, sampleRateHz: Number(event.target.value) }))}
                >
                  {sampleRateChoices().map((rate) => (
                    <option key={rate} value={rate}>{formatFrequency(rate)}</option>
                  ))}
                </select>
              </Field>

              <Field label="采样深度">
                <Segmented
                  value={String(settings.sampleCount)}
                  options={[
                    { value: "1024", label: "1K" },
                    { value: "2048", label: "2K" },
                    { value: "4096", label: "4K" },
                    { value: "8192", label: "8K" },
                  ]}
                  onChange={(value) => updateSettings((current) => ({ ...current, sampleCount: Number(value) }))}
                />
              </Field>

              <div className="slider-heading">
                <Field label="触发位置" />
                <strong>{settings.pretriggerPercent}% 预触发</strong>
              </div>
              <input
                className="range-input"
                type="range"
                min={0}
                max={90}
                step={5}
                value={settings.pretriggerPercent}
                onChange={(event) => updateSettings((current) => ({ ...current, pretriggerPercent: Number(event.target.value) }))}
              />
              <div className="range-scale"><span>0%</span><span>50%</span><span>90%</span></div>
            </section>

            <section className="control-section">
              <div className="section-heading compact">
                <span className="section-icon trigger"><Zap size={15} /></span>
                <div><h2>触发方式</h2><p>硬件实时判定</p></div>
              </div>
              <Segmented
                value={settings.triggerMode}
                options={[
                  { value: "immediate", label: "立即" },
                  { value: "level", label: "电平" },
                  { value: "edge", label: "边沿" },
                ]}
                onChange={(value) =>
                  updateSettings((current) => ({ ...current, triggerMode: value as AppSettings["triggerMode"] }))
                }
              />

              {settings.triggerMode === "immediate" && (
                <div className="trigger-note">
                  <ScanLine size={16} />
                  <span>采样开始后立即锁定当前窗口，适合连续观察和调试输出。</span>
                </div>
              )}
              {settings.triggerMode === "level" && (
                <div className="trigger-matrix">
                  <div className="matrix-head"><span>通道</span><span>参与</span><span>高/低</span></div>
                  {CHANNEL_NAMES.map((channel) => {
                    const enabled = settings.triggerChannels.includes(channel);
                    const high = settings.highChannels.includes(channel);
                    return (
                      <div className="matrix-row" key={channel}>
                        <strong>{channel}</strong>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(event) => updateLevelChannel(channel, event.target.checked, high)}
                        />
                        <Segmented
                          compact
                          value={high ? "high" : "low"}
                          options={[{ value: "high", label: "H" }, { value: "low", label: "L" }]}
                          onChange={(value) => updateLevelChannel(channel, true, value === "high")}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              {settings.triggerMode === "edge" && (
                <div className="edge-trigger-list">
                  {CHANNEL_NAMES.map((channel) => {
                    const edge = settings.edges.find((item) => item.channel === channel);
                    return (
                      <div className="edge-row" key={channel}>
                        <strong>{channel}</strong>
                        <Segmented
                          compact
                          value={edge?.direction ?? "off"}
                          options={[
                            { value: "off", label: "关闭" },
                            { value: "rising", label: "↑" },
                            { value: "falling", label: "↓" },
                          ]}
                          onChange={(value) => updateEdgeChannel(channel, value)}
                        />
                      </div>
                    );
                  })}
                  <p className="micro-copy">任一所选边沿成立即触发。</p>
                </div>
              )}
            </section>

            <section className="capture-actions">
              <button className="capture-button" disabled={!connected || busy} onClick={() => void captureOnce()}>
                <span className="capture-icon"><CircleStop size={17} /></span>
                <span><strong>采集一帧</strong><small>写入持久历史</small></span>
              </button>
              <button
                className={repeatActive ? "repeat-button active" : "repeat-button"}
                disabled={!connected || busy}
                onClick={() => void toggleRepeat()}
              >
                {repeatActive ? <Pause size={16} /> : <Play size={16} />}
                {repeatActive ? "停止重复采集" : "开始重复采集"}
              </button>
              <div className="fps-row">
                <span>刷新率</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  value={settings.repeatFps}
                  onChange={(event) => updateSettings((current) => ({ ...current, repeatFps: Number(event.target.value) }))}
                />
                <strong>{settings.repeatFps} FPS</strong>
              </div>
              <div className="queue-note">
                <Clock3 size={14} />
                等待触发超过 200 ms 时自动让出给 MCP
              </div>
            </section>
          </aside>

          <section className="analyzer-panel">
            <div className="channel-strip">
              <div className="channel-strip-label">
                <Gauge size={16} />
                <span>通道显示</span>
              </div>
              {CHANNEL_NAMES.map((channel) => (
                <label key={channel} className={`channel-toggle ${settings.channelVisibility[channel] ? "active" : ""} ${channel.toLowerCase()}`}>
                  <input
                    type="checkbox"
                    checked={settings.channelVisibility[channel]}
                    onChange={(event) => setChannelVisible(channel, event.target.checked)}
                  />
                  <span />
                  {channel}
                </label>
              ))}
              <div className="capture-source">
                {latestCapture?.source === "mcp" ? <Cpu size={14} /> : <Activity size={14} />}
                {latestCapture?.source === "mcp" ? "MCP 采集帧" : "桌面采集帧"}
              </div>
            </div>

            <WaveformCanvas frame={latestCapture} visibility={settings.channelVisibility} />

            <div className="measurement-strip">
              <div className="measurement-heading">
                <div><span className="eyebrow">测量</span><h2>通道统计</h2></div>
                {latestCapture && (
                  <span className="capture-time">{new Date(latestCapture.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                )}
              </div>
              <div className="measurement-grid">
                {activeMeasurementChannels.length === 0 && (
                  <div className="measurement-empty">采集后显示边沿数、占空比与估算频率。</div>
                )}
                {activeMeasurementChannels.map((channel) => {
                  const highRatio = channel.highCount / (channel.highCount + channel.lowCount);
                  return (
                    <div className={`measurement-item ${channel.channel.toLowerCase()}`} key={channel.channel}>
                      <div><span className="channel-dot" /><strong>{channel.channel}</strong><small>{channel.pin}</small></div>
                      <dl>
                        <dt>频率</dt><dd>{formatFrequency(channel.estimatedFrequencyHz)}</dd>
                        <dt>边沿</dt><dd>{channel.edgeCount.toLocaleString()}</dd>
                        <dt>占空比</dt><dd>{(highRatio * 100).toFixed(1)}%</dd>
                        <dt>首沿</dt><dd>{formatTime(channel.firstEdgeTimeNs)}</dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="source-panel">
            <div className="panel-title source-title">
              <div>
                <span className="eyebrow">信号源</span>
                <h1>输出控制</h1>
              </div>
              <Settings2 size={18} />
            </div>
            <SignalSources
              settings={settings}
              device={snapshot?.device ?? {
                connected: false,
                port: null,
                info: null,
                pin5: null,
                pin11Static: null,
              }}
              disabled={!connected || busy}
              updateSettings={updateSettings}
              configurePin5Square={(frequencyHz) => void configurePin5Square(frequencyHz)}
              configurePin5Engine={(config) => void configurePin5Engine(config)}
              configurePin11={(config) => void configurePin11(config)}
              configurePin11Static={(mode) => void configurePin11Static(mode)}
            />
          </aside>
        </main>
      ) : (
        <main className="history-main">
          <HistoryView
            records={historyRecords}
            usage={storage}
            loading={historyLoading}
            busy={busy}
            onRefresh={() => void refreshHistory()}
            onLoad={(record) => void loadHistory(record)}
            onFavorite={(record, favorite) => void favoriteHistory(record, favorite)}
            onDelete={(record) => void deleteHistory(record)}
            onOpen={openPath}
          />
        </main>
      )}

      <footer className="statusbar">
        <span className={connected ? "footer-status online" : "footer-status"}>
          <span />
          {connected ? "设备在线" : "设备离线"}
        </span>
        <span><Gauge size={13} /> {latestCapture ? formatFrequency(latestCapture.actualSampleRateHz) : "--"}</span>
        <span><Clock3 size={13} /> {latestCapture ? formatTime((latestCapture.sampleCount / latestCapture.actualSampleRateHz) * 1e9) : "--"}</span>
        <span><Database size={13} /> {latestCapture?.sampleCount.toLocaleString() ?? "--"} 点</span>
        <span><HardDrive size={13} /> {formatBytes(storage?.totalBytes ?? 0)}</span>
        <span className="footer-spacer" />
        <span className="footer-message">
          {error ? <AlertTriangle size={13} /> : <Radio size={13} />}
          {error ?? notice ?? snapshot?.activity[0]?.label ?? "就绪"}
        </span>
      </footer>

      {(error || notice) && (
        <div className={error ? "toast error" : "toast"}>
          {error ? <AlertTriangle size={18} /> : <Activity size={18} />}
          <div>
            <strong>{error ? "操作失败" : "操作完成"}</strong>
            <span>{error ?? notice}</span>
          </div>
          <button className="icon-button" title="关闭提示" onClick={() => { setError(null); setNotice(null); }}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );

  function updateLevelChannel(channel: ChannelName, enabled: boolean, high: boolean): void {
    updateSettings((current) => {
      const channels = enabled
        ? [...new Set([...current.triggerChannels, channel])]
        : current.triggerChannels.filter((item) => item !== channel);
      const highs = enabled && high
        ? [...new Set([...current.highChannels, channel])]
        : current.highChannels.filter((item) => item !== channel);
      return {
        ...current,
        triggerChannels: channels.length > 0 ? channels : [channel],
        highChannels: highs,
      };
    });
  }

  function updateEdgeChannel(channel: ChannelName, direction: string): void {
    updateSettings((current) => {
      const remaining = current.edges.filter((item) => item.channel !== channel);
      return {
        ...current,
        edges: direction === "off"
          ? remaining
          : [...remaining, { channel, direction: direction as "rising" | "falling" }],
      };
    });
  }
}

function Field({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="field-group">
      <label>{label}</label>
      {children}
    </div>
  );
}

function buildTrigger(settings: AppSettings): CaptureTrigger {
  if (settings.triggerMode === "immediate") return { mode: "immediate" };
  if (settings.triggerMode === "edge") return { mode: "edge", edges: settings.edges };
  return {
    mode: "level",
    channels: settings.triggerChannels,
    highChannels: settings.highChannels,
  };
}

function firmwareLabel(snapshot: AppSnapshot | null): string {
  const firmware = snapshot?.device.info?.firmware;
  return firmware ? `GEN v${firmware.major}.${firmware.minor}` : "GEN --";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
