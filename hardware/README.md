# 硬件资料

这里存放逻辑分析仪的实物照片、PCB 视图、原理图和外壳模型。

## 图片

| 文件 | 内容 |
|---|---|
| `images/assembled-board.jpg` | 焊接完成并装在外壳中的实物照片 |
| `images/enclosure-assembly.png` | 外壳、PCB、排针和接口的装配视图 |
| `images/pcb-front.png` | PCB 正面布线图 |
| `images/pcb-back.png` | PCB 背面布线图 |
| `images/schematic.png` | AG32VF303、USB、电源、晶振和接口原理图 |

## 外壳

| 文件 | 内容 |
|---|---|
| `enclosure/top-case.step` | 逻辑分析仪顶壳 |
| `enclosure/bottom-case.step` | 逻辑分析仪底壳 |

两个 STEP 文件由 EasyEDA Pro 导出，格式为 STEP AP214，长度单位为毫米。仓库只保留模型本身，不附带特定打印机的切片参数。打印前应结合所用材料、喷嘴直径和装配间隙检查模型尺寸。
