import type { Ref } from "react";
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
  return (
    <label className="search mw-search">
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
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
