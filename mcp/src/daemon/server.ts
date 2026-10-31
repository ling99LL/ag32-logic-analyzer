import fs from "node:fs/promises";
import net from "node:net";
import type {
  ClientRole,
  DaemonEvent,
  DaemonHello,
  DaemonMethod,
  DaemonRequest,
  DaemonResponse,
} from "../shared/types.js";
import { DaemonBroker } from "./broker.js";
import { daemonPipePath, resolveDataDir } from "./paths.js";
import { CaptureStore } from "./storage.js";

interface Session {
  id: string;
  role: ClientRole;
  name: string;
  socket: net.Socket;
  buffer: string;
}

export async function startDaemonServer(): Promise<void> {
  const pipePath = daemonPipePath();
  if (process.platform !== "win32") await fs.rm(pipePath, { force: true }).catch(() => undefined);

  const store = new CaptureStore(resolveDataDir());
  const sessions = new Map<string, Session>();
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const broker = new DaemonBroker(store, scheduleIdleCheck);
  await broker.init();

  const server = net.createServer((socket) => {
    const session: Session = {
      id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "cli",
      name: "未命名客户端",
      socket,
      buffer: "",
    };
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      session.buffer += chunk;
      void processBuffer(session);
    });
    socket.on("close", () => {
      sessions.delete(session.id);
      broker.removeClient(session.id);
      scheduleIdleCheck();
    });
    socket.on("error", () => undefined);
  });

  server.on("error", async (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  });

  server.listen(pipePath, () => {
    scheduleIdleCheck();
  });

  async function processBuffer(session: Session): Promise<void> {
    while (true) {
      const newline = session.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = session.buffer.slice(0, newline).trim();
      session.buffer = session.buffer.slice(newline + 1);
      if (!line) continue;
      let request: DaemonRequest | DaemonHello;
      try {
        request = JSON.parse(line) as DaemonRequest | DaemonHello;
      } catch {
        continue;
      }
      try {
        if (request.method === "hello") {
          const input = request.params as { role?: ClientRole; name?: string } | undefined;
          session.role = input?.role ?? "cli";
          session.name = input?.name ?? session.role;
          sessions.set(session.id, session);
          broker.addClient({
            id: session.id,
            role: session.role,
            name: session.name,
            send: (message) => send(session.socket, message),
          });
          send(session.socket, { id: request.id, ok: true, result: { id: session.id } });
          continue;
        }
        if (!sessions.has(session.id)) throw new Error("客户端尚未完成 hello");
        const result = await broker.handle(request.method as DaemonMethod, request.params, session.role);
        send(session.socket, { id: request.id, ok: true, result });
      } catch (error) {
        send(session.socket, {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function scheduleIdleCheck(): void {
    if (shuttingDown) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (broker.clientCount() > 0) {
      idleTimer = null;
      return;
    }
    idleTimer = setTimeout(() => void shutdown(), 10_000);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    await broker.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await fs.rm(pipePath, { force: true }).catch(() => undefined);
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("uncaughtException", (error) => {
    console.error(error);
    void shutdown();
  });
}

function send(socket: net.Socket, message: DaemonResponse | DaemonEvent | unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
