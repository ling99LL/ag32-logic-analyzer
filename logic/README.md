# CPLD 逻辑工程索引

器件固定为 `AGRV2KQ32`（QFN32）。修改 `.ve` 或本目录 Verilog 后，必须重建位流并重新烧录 logic；只改 MCU C 代码不需要重建逻辑。

## 手写源码

| 文件 | 说明 |
|---|---|
| `logic_board.v` | 顶层逻辑，负责 MCU/CPLD 寄存器和 AHB 接口 |
| `la_sampler.v` | 四通道硬件采样与预触发 |
| `analog_ip.v` | DAC 波形硬宏、PIN_5 数字方波和脉冲引擎 |
| `ahb2apb.v` | AHB 到 APB 桥 |

不要删除 `analog_ip.v` 中 DAC 的 keep-guard，也不要把 PIN_11 重新分配给数字逻辑。

## 工程与约束

| 文件 | 说明 |
|---|---|
| `logic_board.qpf` / `.qsf` | Quartus 工程与引脚/分区约束 |
| `logic_board.sdc` | 时序约束 |
| `logic_board.asf` | 用户布局约束，包含 DAC0 的 `FIXED_COORD {22 11}` |
| `logic_board.vex` / `.proj` | Supra 器件和运行配置 |
| `af_*.tcl` | AGM/Supra 批处理与宏扫描脚本 |
| `run_quartus_steps.bat` | 本机稳定的 Quartus 分步流程和硬宏护栏 |
| `run_supra.bat` | Supra 布局布线入口 |

## 交付物

| 文件 | 说明 |
|---|---|
| `logic_board.bin` | 已上板验证的压缩位流，加载地址 `0x80034000`；必须保留 |
| `dac_macro_fix_evidence.txt` | DAC 硬宏保留和修复证据 |

## 可生成目录

`db/`、`incremental_db/`、`quartus_logs/`、`simulation/`、`alta_db/`、`alta_logs/` 和 `logic_board_routed.v` 均可重建，已在 `.gitignore` 中排除。正式重建流程：

```powershell
cd C:\Users\Administrator\Documents\ag32-logic-analyzer
pio run -e logic_analyzer -t prelogic
cd logic
.\run_quartus_steps.bat
.\run_supra.bat
cd ..
pio run -e logic_analyzer -t logic
pio run -e logic_analyzer -t upload
```

本机 Quartus 13 收尾可能返回 `0xC0000409`，以分步脚本的 summary 检查为准。不要使用 `run_quartus.tcl` 的一键流程替代分步脚本。
