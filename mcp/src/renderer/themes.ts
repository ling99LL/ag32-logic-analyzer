import type { UiTheme } from "../shared/types.js";

export interface ThemeOption {
  value: UiTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    value: "graphite",
    label: "石墨青",
    description: "深色工作台",
    swatches: ["#151a17", "#55d6be", "#e5f0e9"],
  },
  {
    value: "slate",
    label: "冷蓝",
    description: "蓝灰仪器面板",
    swatches: ["#19232e", "#60c5f1", "#e5edf4"],
  },
  {
    value: "light",
    label: "极光",
    description: "浅色高对比",
    swatches: ["#eef2f4", "#0b7f76", "#18242a"],
  },
  {
    value: "ember",
    label: "暖碳",
    description: "暖灰低眩光",
    swatches: ["#211c1a", "#ecab7b", "#f2e9e2"],
  },
];

export function themeOption(theme: UiTheme): ThemeOption {
  return THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0];
}
