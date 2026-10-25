//! 用户自己保存、随时复制的 Prompt。与润色规则和润色历史完全分离。

use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedPrompt {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavePromptInput {
    id: Option<String>,
    title: String,
    content: String,
}

pub(crate) struct PromptLibrary {
    path: PathBuf,
    prompts: Vec<SavedPrompt>,
    counter: u64,
}

impl PromptLibrary {
    pub(crate) fn load(path: PathBuf) -> Self {
        let prompts = read_json_with_backup::<Vec<SavedPrompt>>(&path).unwrap_or_default();
        Self {
            path,
            prompts,
            counter: 0,
        }
    }

    fn save(&mut self, input: SavePromptInput) -> Result<Vec<SavedPrompt>, String> {
        if input.content.trim().is_empty() {
            return Err("Prompt 内容不能为空".into());
        }
        if input.content.chars().count() > 200_000 {
            return Err("Prompt 内容过长".into());
        }
        let now = now_millis();
        let title = prompt_title(&input.title, &input.content);
        let before = self.prompts.clone();
        if let Some(id) = input.id.as_deref().filter(|id| !id.is_empty()) {
            let prompt = self
                .prompts
                .iter_mut()
                .find(|prompt| prompt.id == id)
                .ok_or_else(|| "这条 Prompt 已不存在".to_string())?;
            prompt.title = title;
            prompt.content = input.content;
            prompt.updated_at = now;
        } else {
            self.counter += 1;
            self.prompts.insert(
                0,
                SavedPrompt {
                    id: format!("saved-prompt-{now}-{}", self.counter),
                    title,
                    content: input.content,
                    created_at: now,
                    updated_at: now,
                },
            );
        }
        if let Err(error) = write_json_atomic(&self.path, &self.prompts) {
            self.prompts = before;
            return Err(error);
        }
        Ok(self.prompts.clone())
    }

    fn delete(&mut self, id: &str) -> Result<Vec<SavedPrompt>, String> {
        let index = self
            .prompts
            .iter()
            .position(|prompt| prompt.id == id)
            .ok_or_else(|| "这条 Prompt 已不存在".to_string())?;
        let removed = self.prompts.remove(index);
        if let Err(error) = write_json_atomic(&self.path, &self.prompts) {
            self.prompts.insert(index, removed);
            return Err(error);
        }
        Ok(self.prompts.clone())
    }
}

fn prompt_title(title: &str, content: &str) -> String {
    let title = title.trim();
    let source = if title.is_empty() {
        content
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
    } else {
        title
    };
    let source = source.trim();
    let mut label: String = source.chars().take(80).collect();
    if source.chars().count() > 80 {
        label.push('…');
    }
    if label.is_empty() {
        "未命名 Prompt".into()
    } else {
        label
    }
}

pub(crate) async fn show_prompt_library(app: AppHandle) -> Result<(), String> {
    // 和工作区里的素材库一样按需创建，避免应用启动时多挂一个 WebView。
    static OPEN_LOCK: Mutex<()> = Mutex::new(());
    let _guard = OPEN_LOCK.lock();
    let window = match app.get_webview_window("prompt-library") {
        Some(window) => window,
        None => tauri::WebviewWindowBuilder::new(
            &app,
            "prompt-library",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title(ui_text("Prompt 库 · Snapshot", "Prompt Library · Snapshot"))
        .inner_size(900.0, 640.0)
        .min_inner_size(600.0, 480.0)
        .resizable(true)
        .center()
        .visible(false)
        .build()
        .map_err(|error| format!("无法创建 Prompt 库窗口：{error}"))?,
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    actions::hide_quick_menu(app.clone());
    let _ = app.emit_to("prompt-library", "prompt-library-opened", ());
    Ok(())
}

#[tauri::command]
pub(crate) async fn show_prompt_library_window(app: AppHandle) -> Result<(), String> {
    show_prompt_library(app).await
}

#[tauri::command]
pub(crate) fn hide_prompt_library(app: AppHandle) {
    if let Some(window) = app.get_webview_window("prompt-library") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub(crate) fn list_saved_prompts(state: State<'_, AppState>) -> Vec<SavedPrompt> {
    state.saved_prompts.lock().prompts.clone()
}

#[tauri::command]
pub(crate) fn save_saved_prompt(
    state: State<'_, AppState>,
    input: SavePromptInput,
) -> Result<Vec<SavedPrompt>, String> {
    state.saved_prompts.lock().save(input)
}

#[tauri::command]
pub(crate) fn delete_saved_prompt(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SavedPrompt>, String> {
    state.saved_prompts.lock().delete(&id)
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
                "snapshot-prompt-library-{}-{}-{}",
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

    fn input(id: Option<&str>, title: &str, content: &str) -> SavePromptInput {
        SavePromptInput {
            id: id.map(str::to_string),
            title: title.into(),
            content: content.into(),
        }
    }

    #[test]
    fn prompts_survive_restart_and_can_be_updated_and_deleted() {
        let dir = TestDir::new();
        let path = dir.0.join("prompts.json");
        let mut library = PromptLibrary::load(path.clone());
        let list = library
            .save(input(None, "整理需求", "请把需求整理成步骤"))
            .unwrap();
        let id = list[0].id.clone();
        assert_eq!(list[0].title, "整理需求");
        assert_eq!(list[0].content, "请把需求整理成步骤");

        library
            .save(input(Some(&id), "整理需求 v2", "新的内容"))
            .unwrap();
        let restored = PromptLibrary::load(path);
        assert_eq!(restored.prompts.len(), 1);
        assert_eq!(restored.prompts[0].title, "整理需求 v2");
        assert_eq!(restored.prompts[0].content, "新的内容");

        let mut restored = restored;
        assert!(restored.delete(&id).unwrap().is_empty());
        assert!(PromptLibrary::load(dir.0.join("prompts.json"))
            .prompts
            .is_empty());
    }

    #[test]
    fn blank_title_comes_from_the_first_non_empty_line_and_blank_content_is_rejected() {
        let dir = TestDir::new();
        let mut library = PromptLibrary::load(dir.0.join("prompts.json"));
        let list = library
            .save(input(None, "", "\n\n你是一名审阅者，请逐条列出问题。"))
            .unwrap();
        assert_eq!(list[0].title, "你是一名审阅者，请逐条列出问题。");
        assert!(library.save(input(None, "空", "  \n ")).is_err());
    }
}
