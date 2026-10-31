import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Moon, Palette, Sun } from "lucide-react";
import type { UiTheme } from "../../shared/types.js";
import { THEME_OPTIONS, themeOption } from "../themes.js";

export function ThemePicker({
  value,
  onChange,
  onOpenChange,
}: {
  value: UiTheme;
  onChange: (theme: UiTheme) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = themeOption(value);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="theme-picker" ref={rootRef}>
      <button
        className="theme-trigger"
        title="选择界面主题"
        aria-label="选择界面主题"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {value === "light" ? <Sun size={15} /> : <Moon size={15} />}
        <span className="theme-trigger-swatches">
          {current.swatches.slice(0, 2).map((color) => <i key={color} style={{ background: color }} />)}
        </span>
        <span>{current.label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="theme-menu" role="menu">
          <div className="theme-menu-heading">
            <Palette size={14} />
            <span>界面主题</span>
          </div>
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === value}
              className={option.value === value ? "theme-option selected" : "theme-option"}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className={`theme-preview ${option.value}`}>
                <i style={{ background: option.swatches[0] }} />
                <i style={{ background: option.swatches[1] }} />
                <i style={{ background: option.swatches[2] }} />
              </span>
              <span className="theme-option-label">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {option.value === value && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
