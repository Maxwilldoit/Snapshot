import { useEffect, useRef, type Ref } from "react";
import { Search, X } from "lucide-react";
import { useI18n } from "../lib/i18n";

export function SearchField({
  value,
  onChange,
  label,
  placeholder = label,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const { t } = useI18n();
  const innerRef = useRef<HTMLInputElement | null>(null);

  // Ctrl/Cmd+F 聚焦本页搜索；工具栏里收起的搜索框会随聚焦一起展开
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        innerRef.current?.focus();
        innerRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const attachRef = (node: HTMLInputElement | null) => {
    innerRef.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) inputRef.current = node;
  };

  return (
    <label className={`search mw-search ${value ? "is-active" : ""}`}>
      <Search aria-hidden="true" />
      <input
        ref={attachRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label={t("清除搜索")}
          onClick={(event) => {
            onChange("");
            event.currentTarget.parentElement?.querySelector("input")?.focus();
          }}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </label>
  );
}
