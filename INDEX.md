# AG32 Logic Studio 文件索引

本文件是仓库的唯一总入口，用于快速查找源码、固件、CPLD 逻辑、硬件资料、测试脚本、上位机文档和发布产物。日常修改前先从这里定位文件；子目录说明见各目录的 `README.md`。

## 顶层结构

```text
ag32-logic-analyzer/
├─ src/                 AG32 MCU 固件
├─ logic/               CPLD 逻辑、Quartus/Supra 工程和已验证位流
├─ hardware/            原理图、PCB、实物照片和外壳 STEP
├─ tools/               上板测试、波形脚本和历史日志
├─ captures/            已验证 VCD 与 PulseView 截图
├─ docs/                交接文档、测试报告和示意图
├─ mcp/                 Electron 桌面端、ag32d 与 MCP server
├─ INDEX.md             本文件
├─ README.md            项目介绍、下载和快速开始
├─ platformio.ini       PlatformIO/AgRV 构建配置
└─ logic_board.ve       CPLD 顶层与引脚约束入口
```

## 快速查找

| 需要找什么 | 去哪里 |
|---|---|
| 安装 EXE、便携 ZIP、最新版本 | [GitHub Release](https://github.com/ling99LL/ag32-logic-analyzer/releases/latest)；本机构建包位于 `mcp/release/` |
| 项目介绍、下载、接线和烧录 | [README.md](README.md) |
| 开发环境、排障和历史交接 | [docs/HANDOVER.md](docs/HANDOVER.md) |
| 性能、压测和时基数据 | [docs/reports/PERFORMANCE_REPORT.md](docs/reports/PERFORMANCE_REPORT.md) |
| 最近一次 PIN_5/CH1 上板测试 | [docs/reports/TEST_REPORT_2026-10-21_PIN5_CH1.md](docs/reports/TEST_REPORT_2026-10-21_PIN5_CH1.md) |
| MCU 固件入口 | [src/main.c](src/main.c) |
| CPLD 采样器 | [logic/la_sampler.v](logic/la_sampler.v) |
| DAC/数字信号发生器逻辑 | [logic/analog_ip.v](logic/analog_ip.v) |
| 已验证 CPLD 位流 | [logic/logic_board.bin](logic/logic_board.bin) |
| 上板测试和主机侧脚本 | [tools/README.md](tools/README.md) |
| 桌面端、共享后台和 MCP | [mcp/README.md](mcp/README.md) |
| PCB、原理图、实物和外壳 | [hardware/README.md](hardware/README.md) |
| 已验证抓图 | [captures/README.md](captures/README.md) |

## 根目录文件

| 文件 | 类别 | 说明 |
|---|---|---|
| `README.md` | 项目入口 | 对外介绍、版本下载、参数与构建流程 |
| `INDEX.md` | 索引 | 本文件 |
| `platformio.ini` | 构建配置 | `AGRV2KQ32`、固件源目录、CPLD 逻辑工程和烧录协议 |
| `logic_board.ve` | 逻辑入口 | 顶层模块与 QFN32 引脚约束；修改后必须重建逻辑 |
| `.gitattributes` | Git 配置 | 二进制和换行规则 |
| `.gitignore` | Git 配置 | 构建缓存、二进制中间品和日志忽略规则 |

## 功能目录

### `src/` — MCU 固件

| 文件 | 说明 |
|---|---|
| `main.c` | SUMP/OLS 协议、采样控制、信号发生器命令与状态机 |
| `usb_descriptors.c` | USB CDC/设备描述符 |
| `tusb_config.h` | TinyUSB 配置 |

### `logic/` — CPLD 逻辑

详细说明见 [logic/README.md](logic/README.md)。

| 类别 | 文件 |
|---|---|
| 手写逻辑源 | `logic_board.v`、`la_sampler.v`、`analog_ip.v`、`ahb2apb.v` |
| Quartus 工程 | `logic_board.qpf`、`.qsf`、`.sdc`、`.proj`、`.vex`、`.asf` |
| 构建脚本 | `run_quartus_steps.bat`、`run_supra.bat`、`af_*.tcl`、`run_quartus.tcl` |
| 可烧录位流 | `logic_board.bin` |
| DAC 修复证据 | `dac_macro_fix_evidence.txt` |

`logic/` 下的 `db/`、`incremental_db/`、`quartus_logs/`、`simulation/`、`alta_db/`、`alta_logs/` 都是可重建中间目录，已清理并忽略。

### `hardware/` — 硬件资料

详细图片说明见 [hardware/README.md](hardware/README.md)。

| 子目录 | 内容 |
|---|---|
| `images/` | 实物、PCB、原理图和装配截图 |
| `enclosure/` | `top-case.step`、`bottom-case.step` 外壳模型 |

### `tools/` — 测试与辅助工具

详细说明见 [tools/README.md](tools/README.md)。

| 路径 | 内容 |
|---|---|
| `tools/smoke_test.py` | 烧录后综合冒烟 |
| `tools/loopback_test.py` | 板级信号回环 |
| `tools/dac_rate_probe.py` | DAC 速率探测 |
| `tools/wavegen_gui.py` | Tkinter 信号发生器 |
| `tools/flash_blank_swd.ps1` | 空片 SWD 全镜像烧录 |
| `tools/host/` | 命令行采集、USB 压测、时基与性能测试 |
| `tools/logs/` | 历史测试输出，只作证据保留 |

### `captures/` — 采集样本

| 文件 | 说明 |
|---|---|
| `planb-capture-2026-10-10.vcd` | 已验证四通道 VCD |
| `pulseview_check.png` | PulseView 连接成功截图 |

### `docs/` — 文档

详细导航见 [docs/README.md](docs/README.md)。测试报告放在 `docs/reports/`，示意图放在 `docs/images/`。

### `mcp/` — 桌面上位机与 MCP

详细说明见 [mcp/README.md](mcp/README.md)。

| 路径 | 内容 |
|---|---|
| `src/renderer/` | React 浅色工作台 |
| `src/desktop/` | Electron 主进程与 preload |
| `src/daemon/` | 独占 USB CDC 的共享后台 |
| `src/device.ts` | 串口设备与 SUMP/OLS 协议 |
| `src/index.ts` | MCP stdio server |
| `src/test/` | TypeScript 自动化测试 |
| `scripts/` | MCP、UI、硬件与辅助脚本 |
| `build/` | Electron 图标资源 |
| `docs/images/` | 桌面端三张界面截图 |
| `release/` | 本地生成的安装 EXE 与便携 ZIP |

`mcp/node_modules/`、`mcp/dist/`、`mcp/artifacts/`、`mcp/release/win-unpacked/` 都是可重建目录，已从工作区清理。

## 生成物与保留规则

| 规则 | 说明 |
|---|---|
| 不手工修改生成目录 | Quartus、PlatformIO、Vite、Electron 产物由命令重新生成 |
| 位流例外 | `logic/logic_board.bin` 是上板验证过的交付物，必须保留 |
| 最新发布包保留 | `mcp/release/` 只保留当前版本的 setup EXE 和 portable ZIP |
| 报告移动 | 新增长期报告放 `docs/reports/`，短期运行日志放 `tools/logs/` |
| 新脚本归类 | 主机侧协议/压测脚本放 `tools/host/`；板级工具放 `tools/` |
| 新截图归类 | UI 截图放 `mcp/docs/images/`；硬件照片放 `hardware/images/`；示意图放 `docs/images/` |

## 常用验证

```powershell
cd C:\Users\Administrator\Documents\ag32-logic-analyzer

# 桌面端
cd mcp
npm ci
npm run check
npm run selftest
python scripts\ui_smoke.py

# 固件构建
cd ..
pio run -e logic_analyzer
```
