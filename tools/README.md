# 工具索引

所有命令默认从仓库根目录执行。串口、烧录和回环前提见根目录 [README](../README.md) 与 [HANDOVER](../docs/HANDOVER.md)。

## 板级工具

| 文件 | 用途 |
|---|---|
| `smoke_test.py` | 设备握手、采样、信号源和协议综合冒烟 |
| `loopback_test.py` | PIN_5/PIN_11 到输入通道的物理回环 |
| `dac_rate_probe.py` | DAC 播表速率探测 |
| `wavegen_gui.py` | Tkinter 信号发生器控制界面 |
| `run_wavegen.bat` | 启动信号发生器界面 |
| `flash_blank_swd.ps1` | 空片 option bytes、logic、firmware 批处理烧录 |

## 主机侧脚本

`host/` 保存直接通过 SUMP/OLS 命令调试设备的命令行脚本：

| 文件 | 用途 |
|---|---|
| `host/run_la.py` | 命令行采集、ASCII 预览和 VCD 导出 |
| `host/capture_and_visualize.py` | 捕获并生成 VCD/ASCII 波形 |
| `host/live_hardware_test.py` | 时基、触发和满深上传综合回归 |
| `host/test_la.py` | 握手、深度和基础波形测试 |
| `host/test_frequencies.py` | 自测方波频率响应 |
| `host/benchmark_usb.py` | 单包 USB CDC 吞吐测试 |
| `host/benchmark_usb_suite.py` | 连续 CDC 吞吐套件 |
| `host/verify_performance.py` | 多深度吞吐与触发性能测试 |
| `host/export_svg.py` | 抓取波形并更新 `docs/images/plan_b_live_waveform.svg` |

## 历史日志

`logs/` 中的文件是已验证运行记录，不是当前程序的运行时日志。新的临时输出默认被 `.gitignore` 忽略；需要长期留档时再加清晰日期后缀。
