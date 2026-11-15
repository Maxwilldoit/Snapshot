import type { PlatformCapabilities, ShortcutAction } from "../types";

/** Menu entries and shortcut rows use the same runtime capability report.
 * Scrolling is opt-in: platforms without an implementation omit the field. */
export function actionAvailable(action: ShortcutAction, caps: PlatformCapabilities | null): boolean {
  if (action === "scrolling") return caps?.scrolling?.available === true;
  if (action === "record") return caps?.recording.available !== false;
  return true;
}
