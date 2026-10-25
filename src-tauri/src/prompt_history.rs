//! 润色历史：每次成功润色后保存原文、结果、规则和时间。
//!
//! 和截图历史一样只从本机界面读取；正文可能很长，所以单独放一个可丢弃的
//! JSON 文件，不塞进设置里的活动列表。记录会一直保留。

use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptHistoryEntry {
    pub(crate) id: String,
    pub(crate) created_at: u64,
    pub(crate) template: String,
    pub(crate) original: String,
    pub(crate) polished: String,
}

pub(crate) struct PromptHistory {
    path: PathBuf,
    entries: Vec<PromptHistoryEntry>,
    counter: u64,
}

impl PromptHistory {
    pub(crate) fn load(path: PathBuf) -> Self {
        let entries = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<PromptHistoryEntry>>(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            entries,
            counter: 0,
        }
    }

    fn push(&mut self, original: &str, polished: &str, template: &str) -> PromptHistoryEntry {
        self.counter += 1;
        let created_at = now_millis();
        let entry = PromptHistoryEntry {
            id: format!("prompt-{created_at}-{}", self.counter),
            created_at,
            template: template.to_string(),
            original: original.to_string(),
            polished: polished.to_string(),
        };
        self.entries.insert(0, entry.clone());
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(payload) = serde_json::to_vec(&self.entries) {
            let _ = fs::write(&self.path, payload);
        }
        entry
    }
}

/// 只在润色成功后调用；写盘失败不影响用户拿到结果。
pub(crate) fn record(app: &AppHandle, original: &str, polished: &str, template: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let entry = state
        .prompt_history
        .lock()
        .push(original, polished, template);
    let _ = app.emit("prompt-history-changed", &entry);
}

#[tauri::command]
pub(crate) fn list_prompt_history(state: State<'_, AppState>) -> Vec<PromptHistoryEntry> {
    state.prompt_history.lock().entries.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
            Self(std::env::temp_dir().join(format!(
                "snapshot-prompt-history-{}-{}-{}",
                std::process::id(),
                now_millis(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn successful_records_survive_restart_and_stay_newest_first() {
        let dir = TestDir::new();
        let path = dir.0.join("prompt-history.json");
        let mut history = PromptHistory::load(path.clone());
        history.push("原文一", "润色一", "规则一");
        history.push("原文二", "润色二", "规则二");

        let restored = PromptHistory::load(path);
        assert_eq!(restored.entries.len(), 2);
        assert_eq!(restored.entries[0].original, "原文二");
        assert_eq!(restored.entries[0].polished, "润色二");
        assert_eq!(restored.entries[0].template, "规则二");
        assert!(restored.entries[0].created_at > 0);
    }

    #[test]
    fn history_keeps_every_entry_beyond_the_old_limit() {
        let dir = TestDir::new();
        let path = dir.0.join("prompt-history.json");
        let mut history = PromptHistory::load(path.clone());
        for index in 0..250 {
            history.push(&format!("原文 {index}"), &format!("润色 {index}"), "规则");
        }

        let restored = PromptHistory::load(path);
        assert_eq!(restored.entries.len(), 250);
        assert_eq!(restored.entries[0].original, "原文 249");
        assert_eq!(restored.entries.last().unwrap().original, "原文 0");
    }
}
