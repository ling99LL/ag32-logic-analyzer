import { SerialPort } from "serialport";
import {
  OPS,
  ProtocolError,
  SUMP_BAUD_RATE,
  parseInfoFrame,
  parsePin5StatusFrame,
} from "./protocol.js";

export interface SerialLike {
  write(data: Buffer | Uint8Array): Promise<void>;
  read(length: number, timeoutMs?: number): Promise<Buffer>;
  close(): Promise<void>;
  flush(): Promise<void>;
}

export class Ag32SerialDevice implements SerialLike {
  readonly port: SerialPort;
  private pending: Buffer[] = [];
  private waiters: Array<{ length: number; resolve: (data: Buffer) => void; reject: (error: Error) => void }> = [];

  private constructor(readonly path: string) {
    this.port = new SerialPort({
      path: this.path,
      baudRate: SUMP_BAUD_RATE,
      autoOpen: true,
    }) as unknown as SerialPort;
    this.port.on("data", (chunk: Buffer) => this.receive(chunk));
    this.port.on("error", (error: Error) => {
      const failure = new Error(`Opening ${this.path}: ${error.message}`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
    });
  }

  static open(path: string): Promise<Ag32SerialDevice | null> {
    return new Promise((resolve) => {
      let device: Ag32SerialDevice | null = null;
      let settled = false;
      const finish = (value: Ag32SerialDevice | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        finish(null);
        void device?.close().catch(() => undefined);
      }, 1000);
      try {
        device = new Ag32SerialDevice(path);
        device.port.once("open", () => finish(device));
        device.port.once("error", () => finish(null));
      } catch {
        finish(null);
      }
    });
  }

  write(data: Buffer | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  read(length: number, timeoutMs = 500): Promise<Buffer> {
    const available = this.takePending(length);
    if (available) return Promise.resolve(available);
    return new Promise<Buffer>((resolve, reject) => {
      const entry = { length, resolve, reject };
      this.waiters.push(entry);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ProtocolError(`Serial read timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      entry.resolve = (data: Buffer | PromiseLike<Buffer>) => {
        clearTimeout(timer);
        resolve(Promise.resolve(data) as unknown as Buffer);
      };
      entry.reject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.close((error) => {
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(error ?? new Error(`Serial port ${this.path} closed`));
        }
        if (error) reject(error);
        else resolve();
      });
    });
  }

  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.flush((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  receive(chunk: Buffer): void {
    this.pending.push(chunk);
    this.flushWaiters();
  }

  private takePending(length: number): Buffer | null {
    if (this.pending.length === 0) return null;
    const joined = Buffer.concat(this.pending);
    if (joined.length < length) return null;
    const result = joined.subarray(0, length);
    const rest = joined.subarray(length);
    this.pending = rest.length > 0 ? [rest] : [];
    return result;
  }

  flushWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      const data = this.takePending(waiter.length);
      if (!data) break;
      this.waiters.shift();
      waiter.resolve(data);
    }
  }
}

export async function readExactly(serial: SerialLike, length: number, timeoutMs = 3000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  const deadline = Date.now() + timeoutMs;
  while (received < length) {
    if (Date.now() > deadline) {
      throw new ProtocolError(`Serial read timed out after ${timeoutMs} ms`);
    }
      const chunk = await serial.read(length - received, Math.max(100, Math.floor(timeoutMs / 10)));
    if (chunk.length > 0) {
      chunks.push(chunk);
      received += chunk.length;
    }
  }
  return Buffer.concat(chunks);
}

export async function probeSumpId(serial: SerialLike): Promise<boolean> {
  await serial.flush();
  await serial.write(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
  await serial.flush();
  await serial.write(Buffer.from([0x02]));
  const response = await readExactly(serial, 4, 500).catch(() => Buffer.alloc(0));
  return response.toString("ascii") === "1ALS";
}

export async function readInfoFrame(serial: SerialLike, timeoutMs = 1000): Promise<ReturnType<typeof parseInfoFrame>> {
  await serial.flush();
  await serial.write(Buffer.from([OPS.getInfo, 0, 0, 0, 0]));
  const header = await readExactly(serial, 2, timeoutMs);
  if (header[0] !== 0xaa) throw new ProtocolError(`Invalid response sync byte: 0x${header[0].toString(16)}`);
  const length = header[1];
  if (length !== 20) throw new ProtocolError(`Expected GET_INFO length 20, received ${length}`);
  return parseInfoFrame(await readExactly(serial, length, timeoutMs));
}

export async function readPin5StatusFrame(
  serial: SerialLike,
  timeoutMs = 1000,
): Promise<ReturnType<typeof parsePin5StatusFrame>> {
  await serial.flush();
  await serial.write(Buffer.from([OPS.pin5Query, 0, 0, 0, 0]));
  const header = await readExactly(serial, 2, timeoutMs);
  if (header[0] !== 0xaa) throw new ProtocolError(`Invalid response sync byte: 0x${header[0].toString(16)}`);
  const length = header[1];
  if (length !== 7) throw new ProtocolError(`Expected PIN_5 status length 7, received ${length}`);
  return parsePin5StatusFrame(await readExactly(serial, length, timeoutMs));
}

export async function listSerialPorts(): Promise<string[]> {
  const ports = await SerialPort.list();
  const preferred = ports
    .filter((port) => port.path === "COM33" || /usb|cdc|serial/i.test(((port as { friendlyName?: string }).friendlyName ?? "")))
    .map((port) => port.path);
  const ordered = new Set<string>(preferred);
  for (const port of ports) ordered.add(port.path);
  return [...ordered];
}
