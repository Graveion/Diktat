import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, Settings } from "../utils/settings";

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    setSettings((cur) => ({ ...cur, ...patch }));
    await saveSettings(patch);
  }, []);

  return { settings, update, loaded };
}
