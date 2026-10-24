import { formatClock } from "../lib/format";
import { stagger } from "../lib/motion";
import type { PromptHistoryEntry } from "../types";

/** 统一历史流里的一条 Prompt：摘要保留两条预览，展开后显示完整原文与结果。 */
export function PromptHistoryRow({
  record,
  index,
}: {
  record: PromptHistoryEntry;
  index: number;
}) {
  return (
    <details className="prompt-entry history-prompt-item" style={stagger(index)}>
      <summary className="prompt-summary">
        <time className="mono small quiet">{formatClock(record.createdAt)}</time>
        <span className="prompt-preview">
          <span className="prompt-preview-line">
            <span className="prompt-preview-label">原文</span>
            <span className="prompt-preview-text" title={record.original}>{record.original}</span>
          </span>
          <span className="prompt-preview-line">
            <span className="prompt-preview-label">润色</span>
            <span className="prompt-preview-text" title={record.polished}>{record.polished}</span>
          </span>
        </span>
        <span className="prompt-rule small quiet">{record.template}</span>
      </summary>
      <div className="prompt-body">
        <section className="prompt-text">
          <h4>原文</h4>
          <pre>{record.original}</pre>
        </section>
        <section className="prompt-text">
          <h4>润色文</h4>
          <pre>{record.polished}</pre>
        </section>
      </div>
    </details>
  );
}
