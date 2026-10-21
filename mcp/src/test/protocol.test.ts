import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SAMPLE_COUNT,
  MIN_SAMPLE_COUNT,
  makeDividerFrame,
  makeExtendedFrame,
  makeReadCountFrame,
  sampleRateToDivider,
  dividerToSampleRate,
  normalizeSampleCount,
  parseInfoFrame,
  parsePin5StatusFrame,
  encodeTimeNs,
  encodePin5Config,
  pin11FrequencyLimit,
  channelBits,
} from "../protocol.js";
import { analyzeSamples, exportVcd, findActiveChannels } from "../analysis.js";
import { triggerMask } from "../session.js";

test("extended frames are five bytes with little-endian payload", () => {
  assert.deepEqual([...makeExtendedFrame(0x84, 0x01020304)], [0x84, 0x04, 0x03, 0x02, 0x01]);
});

test("sample count frame matches the SUMP word encoding", () => {
  assert.deepEqual([...makeReadCountFrame(1024)], [0x81, 0xff, 0x00, 0xff, 0x00]);
  assert.throws(() => makeReadCountFrame(1023));
});

test("divider and sample count boundaries are enforced", () => {
  assert.equal(sampleRateToDivider(100_000_000), 0);
  assert.equal(sampleRateToDivider(12_207), 8191);
  assert.equal(dividerToSampleRate(0), 100_000_000);
  assert.equal(normalizeSampleCount(MAX_SAMPLE_COUNT + 3), MAX_SAMPLE_COUNT);
  assert.equal(normalizeSampleCount(MIN_SAMPLE_COUNT - 1), MIN_SAMPLE_COUNT);
  assert.deepEqual([...makeDividerFrame(8191)], [0x80, 0xff, 0x1f, 0x00, 0x00]);
});

test("info and PIN_5 status frames are parsed", () => {
  const info = Buffer.alloc(20);
  info[0] = 1;
  info[1] = 1;
  info[2] = 1;
  info[3] = 80;
  info.writeUInt32LE(100_000, 4);
  info.writeUInt32LE(99_000, 8);
  info[12] = 1;
  info[13] = 8;
  info.writeUInt32LE(5_000_000, 14);
  const parsed = parseInfoFrame(info);
  assert.equal(parsed.firmware.minor, 1);
  assert.equal(parsed.waveform, "square");
  assert.equal(parsed.tableLength, 256);

  const pin5 = Buffer.alloc(7);
  pin5[0] = 1;
  pin5.writeUInt32LE(1234, 1);
  pin5.writeUInt16LE(1 << 4, 5);
  const pin5Parsed = parsePin5StatusFrame(pin5);
  assert.equal(pin5Parsed.busy, true);
  assert.equal(pin5Parsed.tickNs, 100);
  assert.equal(pin5Parsed.remainingNs, 123_400);
});

test("PIN_5 and PIN_11 configuration helpers match the documented encodings", () => {
  assert.equal(encodePin5Config({ mode: "delayed_level", activeLevel: "high", idleLevel: "low", prescale: 0 }), 0x04);
  assert.deepEqual(encodeTimeNs(1_000), { prescale: 0, ticks: 100, tickNs: 10 });
  assert.equal(pin11FrequencyLimit(5_000_000, "square"), 2_500_000);
  assert.equal(channelBits(["CH1", "CH4"]), 0b1001);
});

test("level trigger masks are generated from channel names", () => {
  assert.deepEqual(triggerMask(["CH1", "CH2"], ["CH2"]), { mask: 0b0011, value: 0b0010 });
  assert.throws(() => triggerMask(["CH1"], ["CH2"]));
});

test("channel measurements and VCD export are internally consistent", () => {
  const samples = Buffer.from([0b0000, 0b0001, 0b0010, 0b0100, 0b1000]);
  const measurements = analyzeSamples(samples, 100_000_000);
  assert.deepEqual(findActiveChannels(measurements, 1), ["CH1", "CH2", "CH3", "CH4"]);
  assert.equal(measurements[0].edgeCount, 2);
  assert.equal(measurements[0].highCount, 1);
  const vcd = exportVcd(samples, 100_000_000);
  assert.match(vcd, /\$var wire 1 ! CH1_PIN_7 \$end/);
  assert.match(vcd, /#10/);
});
