import { useEffect, useState } from "react";
import { errorText } from "../app/context";
import { PetCatalog } from "../components/PetCatalog";
import { loadSettings, onSettingsChanged } from "../lib/backend";
import type { Settings } from "../types";

export function PetCatalogWindow() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let changed = false;
    // 先订阅，再读取快照；避免初始化期间的更新被较早的快照覆盖。
    const pending = onSettingsChanged((next) => {
      if (disposed) return;
      changed = true;
      setSettings(next);
      setError(null);
    });
    void pending.then(async () => {
      if (disposed) return;
      const initial = await loadSettings();
      if (!disposed && !changed) setSettings(initial);
    }).catch((failure) => {
      if (!disposed) setError(errorText(failure));
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [attempt]);

  return (
    <main className="pet-catalog-window">
      {error ? (
        <div className="pet-catalog-state" role="alert">
          <p>读取素材库设置失败：{error}</p>
          <button type="button" className="link" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>重试</button>
        </div>
      ) : settings ? (
        <PetCatalog settings={settings} onSaved={setSettings} />
      ) : <p className="quiet" role="status">正在读取设置…</p>}
    </main>
  );
}
