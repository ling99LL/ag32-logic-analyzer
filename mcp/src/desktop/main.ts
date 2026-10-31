import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { DaemonClient } from "../daemon/client.js";
import type { DaemonMethod } from "../shared/types.js";
import { APP_NAME } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = portableDir
  ? path.join(portableDir, "data")
  : path.join(process.env.LOCALAPPDATA ?? app.getPath("userData"), APP_NAME);

app.setName(APP_NAME);
app.setPath("userData", dataDir);
app.setAppUserModelId("com.ag32.logicstudio");

const daemon = new DaemonClient({
  role: "desktop",
  name: APP_NAME,
  autoStart: true,
  dataDir,
});

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#171b18",
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (process.env.AG32_RENDERER_URL) {
    void mainWindow.loadURL(process.env.AG32_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  daemon.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("ag32:event", event);
    }
  });
  daemon.connect().catch((error) => {
    console.error("Unable to connect to AG32 daemon", error);
  });

  ipcMain.handle("ag32:invoke", async (_event, method: DaemonMethod, params?: unknown) => {
    return daemon.request(method, params, method === "capture" ? 30_000 : 20_000);
  });
  ipcMain.handle("ag32:open-path", async (_event, target: string, reveal = false) => {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(dataDir) + path.sep)) {
      throw new Error("Refusing to open a path outside the AG32 Logic Studio data directory");
    }
    if (reveal) {
      shell.showItemInFolder(resolved);
      return "";
    }
    return shell.openPath(resolved);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => daemon.close());
