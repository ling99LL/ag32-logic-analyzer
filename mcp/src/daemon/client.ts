import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClientRole,
  DaemonEvent,
  DaemonMethod,
  DaemonResponse,
} from "../shared/types.js";
import { daemonPipePath } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonClientOptions {
  role: ClientRole;
  name: string;
  autoStart?: boolean;
  dataDir?: string;
}

export class DaemonClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly listeners = new Set<(event: DaemonEvent) => void>();
  private sequence = 0;

  constructor(private readonly options: DaemonClientOptions) {}

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.openSocket();
    } catch (error) {
      if (!this.options.autoStart) throw error;
      await startDaemon(this.options.dataDir);
      await waitFor(this.openSocket.bind(this), 5000);
    }
    const helloId = this.nextId();
    await this.sendRequestRaw(helloId, "hello", {
      role: this.options.role,
      name: this.options.name,
    });
  }

  async request<T = unknown>(method: DaemonMethod, params?: unknown, timeoutMs = 20_000): Promise<T> {
    if (!this.connected) await this.connect();
    const id = this.nextId();
    return this.sendRequestRaw<T>(id, method, params, timeoutMs);
  }

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Daemon connection closed"));
    }
    this.pending.clear();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(daemonPipePath());
      const handleError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", handleError);
      socket.once("connect", () => {
        socket.off("error", handleError);
        socket.on("error", () => undefined);
        this.attach(socket);
        resolve();
      });
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: DaemonResponse | DaemonEvent;
      try {
        message = JSON.parse(line) as DaemonResponse | DaemonEvent;
      } catch {
        continue;
      }
      if ("event" in message) {
        for (const listener of this.listeners) listener(message);
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error ?? "Daemon request failed"));
    }
  }

  private sendRequestRaw<T>(
    id: string,
    method: string,
    params?: unknown,
    timeoutMs = 20_000,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Daemon is not connected"));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Daemon request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private nextId(): string {
    this.sequence += 1;
    return `${this.options.role}-${process.pid}-${Date.now()}-${this.sequence}`;
  }
}

export async function startDaemon(dataDir?: string): Promise<void> {
  if (await daemonReachable()) return;
  const entry = resolveDaemonEntry();
  const env = {
    ...process.env,
    ...(dataDir ? { AG32_DATA_DIR: dataDir } : {}),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  await waitFor(daemonReachable, 5000);
}

export async function daemonReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(daemonPipePath());
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function resolveDaemonEntry(): string {
  const configured = process.env.AG32_DAEMON_ENTRY;
  if (configured) return path.resolve(configured);
  let entry = path.resolve(__dirname, "index.js");
  if (process.versions.electron && entry.includes("app.asar")) {
    entry = entry.replace("app.asar", "app.asar.unpacked");
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`Cannot find AG32 daemon entry: ${entry}`);
  }
  return entry;
}

async function waitFor(
  predicate: () => Promise<void> | Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== false) return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Timed out waiting for AG32 daemon");
}
