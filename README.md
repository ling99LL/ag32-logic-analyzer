# AG32VF303 Logic Analyzer

这是一个基于 AG32VF303 的四通道逻辑分析仪项目。AG32VF303 内部同时有 RISC-V MCU 和约 2K LE 的 CPLD，本项目用 CPLD 完成硬件同步采样，用 MCU 负责 SUMP/OLS 协议、USB CDC 和板载信号发生器。

设备通过 USB 虚拟串口连接 PulseView，不安装专用驱动。板上还提供一路数字方波/脉冲输出和一路 DAC 波形输出，便于自测和外部触发。

## 当前状态

- 4 通道数字采样，输入为 `PIN_7`、`PIN_8`、`PIN_9`、`PIN_10`
- 最高采样率 `100 MSa/s`，时间分辨率 `10 ns`
- 硬件采样深度 `8192` 点
- 采样时钟为独立 `100 MHz` 总线域，分频公式为 `100 MHz / (div + 1)`
- `PIN_5` 数字方波输出，频率范围 `1 Hz` 到 `100 MHz`
- `PIN_5` 也可切换为延时/主机触发脉冲引擎
- `PIN_11` DAC0 波形输出，支持正弦、方波、锯齿和三角波
- USB 2.0 Full-Speed CDC，兼容 SUMP/OLS，可直接连接 PulseView
- 包含一个面向自动化采集的 MCP server

最近一次上板验证见 [TEST_REPORT_2026-10-21_PIN5_CH1.md](TEST_REPORT_2026-10-21_PIN5_CH1.md)。当前固件版本为 `v1.1`，板上实测结果如下：

- 8 档采样时基全部通过
- `50 MHz @ 100 MSa/s` 连续 100 帧通过，但切换频率后需要等待约 50 ms
- 纯 USB CDC 峰值约 `1.03 MB/s`
- 8192 点满深连续压测 200 帧，无丢帧

## 硬件连接

| 功能 | AG32 引脚 | 说明 |
|---|---:|---|
| CH1 / 采样 bit0 | `PIN_7` | 数字输入，弱下拉 |
| CH2 / 采样 bit1 | `PIN_8` | 数字输入，弱下拉 |
| CH3 / 采样 bit2 | `PIN_9` | 数字输入，弱下拉 |
| CH4 / 采样 bit3 | `PIN_10` | 数字输入，弱下拉 |
| 数字输出 | `PIN_5` | 方波或触发/脉冲引擎 |
| DAC0 输出 | `PIN_11` | 模拟硬核 DAC，固定坐标绑定 |
| USB D- / D+ | `PIN_22` / `PIN_23` | USB Full-Speed |
| UART0 TX / RX | `PIN_20` / `PIN_21` | 调试串口 |
| 状态 LED | `PIN_19`、`PIN_18`、`PIN_13`、`PIN_14` | 低电平点亮 |

CPLD 目标器件是 `AGRV2KQ32`，对应 QFN32 封装。不能改成 LQFP100 默认器件。

## 目录

```text
.
├─ src/                 MCU 固件、USB 描述符
├─ logic/               Quartus 工程、CPLD 采样核和构建脚本
├─ tools/               冒烟、回环、波形发生器上位机
├─ captures/            已验证的 VCD 和截图
├─ mcp/                 MCP server 源码和测试
├─ logic_board.ve       引脚映射文件
├─ platformio.ini       PlatformIO 工程配置
├─ HANDOVER.md          开发环境、烧录流程和排障记录
├─ PERFORMANCE_REPORT.md  采样、触发和 USB 性能报告
└─ TEST_REPORT_2026-10-21_PIN5_CH1.md  最近一次上板结果
```

## 软件环境

- Windows
- PlatformIO Core
- AgRV PlatformIO SDK `1.8.10`
- RISC-V toolchain、Supra、AGM OpenOCD
- Quartus II `13.0sp1`，只重建 CPLD 逻辑时需要
- Python 3.10+，运行上位机脚本
- Node.js 20+，运行 MCP server

工程路径不要包含中文。换电脑后的完整环境说明见 [HANDOVER.md](HANDOVER.md)。

## 编译和烧录

先确认 `platformio.ini` 中的板卡配置：

```ini
[setup_logic]
logic_ve = logic_board.ve
logic_compress = true
logic_device = AGRV2KQ32
ip_name = analog_ip
logic_dir = logic
```

### 只修改 MCU 固件

```powershell
pio run -e logic_analyzer -t upload
```

### 修改引脚或 CPLD 逻辑

修改 `logic_board.ve` 或 `logic/analog_ip.v` 后，需要重新生成和烧录 CPLD 位流：

```powershell
pio run -e logic_analyzer -t prelogic

cd logic
.\run_quartus_steps.bat
.\run_supra.bat
cd ..

pio run -e logic_analyzer -t logic
pio run -e logic_analyzer -t upload
```

本机 Quartus 13 各命令行工具在任务完成后可能以 `0xC0000409` 退出。仓库使用分步脚本，并以每一步的 summary 报告判断结果，不要改用 `run_quartus.tcl` 一键流程。

`analog_ip.v` 中的 DAC keep-guard 和 `run_quartus_steps.bat` 中的 `alta_dac` 检查不能删除，否则 PIN_11 的 DAC 硬核可能被综合优化掉。

## 连接 PulseView

设备枚举为 USB CDC 串口，例如 `COM33`。打开 PulseView：

1. 选择设备驱动 `Openbench Logic Sniffer & SUMP compatibles (ols)`。
2. 接口选择 `Serial Port`。
3. 选择设备对应的 COM 口，波特率填 `115200`。
4. 搜索设备，应看到 `AG32-PlanB`。
5. 采样率选择 `100 MHz` 或其他分频档位，采样深度选择 1K 到 8K。

PulseView 和 MCP、波形发生器不能同时占用同一个 COM 口。

## 测试

上板冒烟测试：

```powershell
python .\tools\smoke_test.py COM33
```

`PIN_5 -> CH1/PIN_7` 回环测试：

```powershell
python .\live_hardware_test.py
```

`PIN_11 -> CH1/PIN_7` DAC 回环测试：

```powershell
python .\tools\loopback_test.py COM33
```

冒烟脚本的测试项会随跳线和当前接线变化。PulseView 连接说明和更多脚本入口见 [HANDOVER.md](HANDOVER.md)。

## 波形发生器

启动图形界面：

```powershell
.\tools\run_wavegen.bat
```

GUI 可以控制：

- PIN_11 DAC 波形类型、频率、幅度和输出开关
- PIN_5 数字方波频率
- PIN_5 延时输出、脉冲宽度、有效电平和主机触发

数字方波由 CPLD 产生。DAC 波表由 DMAC 循环搬运，默认采样率上限为 `5 MSa/s`。

## MCP Server

MCP server 位于 `mcp/`，只负责已烧录设备的连接、采集、触发、测量和信号发生器控制，不包含编译、烧录或 JTAG。

```powershell
cd mcp
npm install
npm run build
npm run check
node .\scripts\mcp_selftest.mjs
node .\dist\index.js
```

注册 MCP 时使用安装目录下的 `mcp\dist\index.js`。设备连接、工具列表和回环检查步骤见 [mcp/README.md](mcp/README.md)。

采集结果会写入 `mcp/runs/`，该目录不提交到仓库。

## 已知限制

- `100 MSa/s` 下，50 MHz 方波只有 2 点/周期，位于奈奎斯特边界。
- PIN_5 可以输出 100 MHz，但逻辑分析仪无法在 100 MSa/s 下完整恢复 100 MHz 波形。
- 协议解码建议保证每 bit 至少 4 个采样点，因此 100 MSa/s 下建议信号不超过约 25 MHz。
- 50 MHz 自测回环需要等待分频器稳定，当前测试建议至少等待 50 ms。
- 采样率是 CPLD 输入采样率，不是模拟带宽，也不是任意输入信号的可靠解码上限。

## 文档

- [HANDOVER.md](HANDOVER.md)：环境、烧录、排障和构建注意事项
- [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md)：采样率、触发和 USB 吞吐数据
- [TEST_REPORT_2026-10-21_PIN5_CH1.md](TEST_REPORT_2026-10-21_PIN5_CH1.md)：最近一次 PIN_5 单线回环测试
- [mcp/README.md](mcp/README.md)：MCP server 使用说明

