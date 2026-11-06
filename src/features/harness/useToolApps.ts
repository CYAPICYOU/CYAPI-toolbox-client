import { useEffect, useState } from 'react';
import { nativeAvailable, nativeCall } from '../../lib/api/native';
import {
  APP_VISIBILITY_KEY,
  parseAppVisibility,
  visibleApps,
  type AppDetectionView,
  type AppEntry,
  type AppVisibility,
} from './apps';

// One scan per app launch, shared across remounts and StrictMode effect replays.
let startupDetection: Promise<AppDetectionView> | undefined;

export function useToolApps<T extends AppEntry>(apps: readonly T[]) {
  const [preferences, setPreferences] = useState<AppVisibility>(() => {
    try {
      return parseAppVisibility(localStorage.getItem(APP_VISIBILITY_KEY), apps);
    } catch {
      return {};
    }
  });
  const [detection, setDetection] = useState<AppDetectionView>({ apps: [] });
  const [loading, setLoading] = useState(nativeAvailable);
  const [ready, setReady] = useState(!nativeAvailable);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    startupDetection ??= nativeCall<AppDetectionView>('tool-apps-detect');
    void startupDetection
      .then(
        (next) => {
          if (active) setDetection(next);
        },
        (error) => {
          if (active) setError(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        if (active) {
          setLoading(false);
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  function persist(next: AppVisibility) {
    try {
      localStorage.setItem(APP_VISIBILITY_KEY, JSON.stringify(next));
    } catch {
      setError('无法保存显示偏好，请检查本地存储后重试。');
      return false;
    }
    setPreferences(next);
    setError('');
    return true;
  }
  return {
    visible: visibleApps(apps, preferences, detection.apps),
    preferences,
    detection,
    loading,
    ready,
    error,
    show: (id: string, shown: boolean) => persist({ ...preferences, [id]: shown }),
    reset: () => persist({}),
  };
}
