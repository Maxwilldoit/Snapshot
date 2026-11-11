import { savePreferences } from "../lib/backend";
import { errorText, useApp } from "../app/context";
import type { Settings } from "../types";

export function usePreferences() {
  const { onSaved, notify } = useApp();
  return async (patch: Partial<Settings>, message?: string) => {
    try {
      onSaved(await savePreferences(patch));
      if (message) notify(message);
    } catch (error) {
      notify(errorText(error), "error");
    }
  };
}
