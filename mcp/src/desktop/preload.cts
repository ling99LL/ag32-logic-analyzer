import { contextBridge, ipcRenderer } from "electron";
import type { DaemonEvent, DaemonMethod } from "../shared/types.js";

contextBridge.exposeInMainWorld("ag32", {
  invoke: (method: DaemonMethod, params?: unknown) => ipcRenderer.invoke("ag32:invoke", method, params),
  subscribe: (listener: (event: DaemonEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DaemonEvent) => listener(payload);
    ipcRenderer.on("ag32:event", wrapped);
    return () => ipcRenderer.off("ag32:event", wrapped);
  },
  openPath: (target: string, reveal = false) => ipcRenderer.invoke("ag32:open-path", target, reveal),
  platform: process.platform,
});
