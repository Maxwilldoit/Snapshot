import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 工具栏按钮下面弹出的一张菜单：贴着按钮下沿，点外面、按 Esc 或选了一项就收起。
 * 菜单里的项用 MenuItem；↑ ↓ 在项之间移动。
 */
export function Menu({
  anchor,
  onClose,
  label,
  align = "end",
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // 右对齐时用 right 定位：菜单内容（窗口列表）晚到、变宽，也只会往左长，不会伸出窗口
  useLayoutEffect(() => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    setPosition(align === "end"
      ? { top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) }
      : { top: box.bottom + 4, left: Math.max(8, box.left) });
  }, [anchor, align]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled), [role=menuitemcheckbox]:not(:disabled)");
    first?.focus({ preventScroll: true });
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchor?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="mw-menu"
      role="menu"
      aria-label={label}
      style={position ?? { visibility: "hidden", top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  children,
  onSelect,
  checked,
  disabled = false,
  danger = false,
  trailing,
}: {
  children: ReactNode;
  onSelect: () => void;
  /** 给了就是可勾选项，左边留出勾的位置 */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      className={`mw-menu-item ${danger ? "is-danger" : ""}`}
      onClick={onSelect}
    >
      <span className="mw-menu-check" aria-hidden="true">
        {checked && (
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.4 4.8 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        )}
      </span>
      <span className="mw-menu-label">{children}</span>
      {trailing && <span className="mw-menu-trailing">{trailing}</span>}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="mw-menu-heading" role="presentation">{children}</div>;
}

export function MenuSeparator() {
  return <div className="mw-menu-sep" role="separator" />;
}

/** 工具栏上一个带菜单的按钮：按钮记住自己，菜单贴着它弹出 */
export function useMenuAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const toggle = useCallback((element: HTMLElement) => setAnchor((current) => (current ? null : element)), []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open: Boolean(anchor), toggle, close };
}
