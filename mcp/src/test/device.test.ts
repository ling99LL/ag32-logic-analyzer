import assert from "node:assert/strict";
import test from "node:test";
import { readExactly, type SerialLike } from "../device.js";

class MockDevice implements SerialLike {
  private buffer: Buffer[] = [];
  private pending: Array<(data: Buffer) => void> = [];
  write() { return Promise.resolve(); }
  read(length: number) {
    if (this.buffer.length > 0) {
      const joined = Buffer.concat(this.buffer);
      if (joined.length >= length) {
        const result = joined.subarray(0, length);
        this.buffer = joined.length > length ? [joined.subarray(length)] : [];
        return Promise.resolve(result);
      }
    }
    return new Promise<Buffer>((resolve) => {
      this.pending.push((data) => resolve(data));
    });
  }
  close() { return Promise.resolve(); }
  flush() { return Promise.resolve(); }
  receive(chunk: Buffer) {
    const waiter = this.pending.shift();
    if (waiter) waiter(chunk);
    else this.buffer.push(chunk);
  }
}

test("serial reader waits for chunked data", async () => {
  const device = new MockDevice();
  const pending = readExactly(device, 5, 500);
  device.receive(Buffer.from([1, 2]));
  device.receive(Buffer.from([3, 4, 5]));
  assert.deepEqual([...(await pending)], [1, 2, 3, 4, 5]);
  await device.close();
});
