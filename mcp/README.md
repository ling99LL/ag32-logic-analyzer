# AG32 Logic MCP

Node.js MCP server for the AG32VF303 four-channel logic analyzer and onboard signal generator. It controls the already-flashed device over its SUMP-compatible USB CDC serial port and intentionally has no build, flash, or JTAG capability.

## Pin map

| Signal | Pin | Direction | Capability |
|---|---:|---|---|
| CH1 | PIN_7 | input | CPLD hardware sampler, bit 0 |
| CH2 | PIN_8 | input | CPLD hardware sampler, bit 1 |
| CH3 | PIN_9 | input | CPLD hardware sampler, bit 2 |
| CH4 | PIN_10 | input | CPLD hardware sampler, bit 3 |
| Digital output B | PIN_5 | output | 1 Hz to 100 MHz square wave, or delayed/host-triggered level and pulse engine |
| Analog output A | PIN_11 | output | DAC0 sine/square/sawtooth/triangle, calibrated default cap 5 MSa/s |

## Run

```powershell
npm install
npm run build
npm run check
node scripts/mcp_selftest.mjs
node dist/index.js
```

Register the MCP server with the stdio command `node <repository>\mcp\dist\index.js`, replacing `<repository>` with the local checkout path.

The USB CDC port is shared with PulseView. Close PulseView before connecting through the MCP, and disconnect the MCP before opening the port in PulseView. `list_devices` identifies the device by SUMP ID `1ALS`; COM33 is only preferred because it is the historically observed port.

## Hardware validation

With the device connected:

1. Use `list_devices` and expect `sumpId: true`, firmware `v1.1`.
2. Configure `PIN_5` to 100 kHz and call `capture`. With no jumper, all CH inputs should be static.
3. Jumper PIN_5 to any CH input, repeat capture, and confirm that channel has edges near 100 kHz.
4. Configure PIN_11 square 100 kHz, jumper PIN_11 to any CH input, capture, then disable PIN_11 and confirm the channel returns to static.
5. Configure the PIN_5 delayed pulse engine, call `arm` or `fire`, and read `busy`, `done`, and remaining ticks with `get_device_info`.

Captures write `samples.bin`, `capture.vcd`, and `manifest.json` to `mcp/runs/<timestamp>/`. Runs are intentionally untracked.
