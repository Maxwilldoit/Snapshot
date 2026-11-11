/**
 * WebView 自带的右键菜单（「在新窗口中打开图像」「重新加载」之类）对桌面应用没有意义，
 * Linux 的 WebKitGTK 在发布版里也照样弹。这里统一收掉，只在能编辑或选中了文字的地方保留，
 * 那里系统菜单的剪切、复制、粘贴有用。组件自己处理过的右键（比如桌宠）不受影响。
 */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

export function allowsNativeContextMenu(target: EventTarget | null, selection: Selection | null = window.getSelection()): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const editable = element?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (editable instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(editable.type) && !editable.disabled;
  if (editable instanceof HTMLTextAreaElement) return !editable.disabled;
  if (editable) return true;
  // 选中了一段文字时右键多半是想复制它
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

export function suppressNativeContextMenu(root: Window = window): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || allowsNativeContextMenu(event.target)) return;
    event.preventDefault();
  };
  root.addEventListener("contextmenu", onContextMenu);
  return () => root.removeEventListener("contextmenu", onContextMenu);
}
