export interface AppEntry {
  id: string;
  name: string;
  hint: string;
}
export interface AppDetection {
  id: string;
  installed: boolean;
  source?: string;
}
export interface AppDetectionView {
  apps: AppDetection[];
  warning?: string;
}
export type AppVisibility = Record<string, boolean>;
export const APP_VISIBILITY_KEY = 'cyapi.appVisibility';
export const DEFAULT_APPS = new Set(['codex', 'claude', 'opencode']);

export function parseAppVisibility(raw: string | null, apps: readonly AppEntry[]): AppVisibility {
  try {
    const value: unknown = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      apps.flatMap(({ id }) => {
        const shown = Object.hasOwn(value, id) ? (value as AppVisibility)[id] : undefined;
        return typeof shown === 'boolean' ? [[id, shown]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function appIsVisible(
  id: string,
  preferences: AppVisibility,
  detected: readonly AppDetection[],
): boolean {
  if (Object.hasOwn(preferences, id)) return preferences[id];
  return DEFAULT_APPS.has(id) || detected.some((app) => app.id === id && app.installed);
}

export function visibleApps<T extends AppEntry>(
  apps: readonly T[],
  preferences: AppVisibility,
  detected: readonly AppDetection[],
): T[] {
  return apps.filter(({ id }) => appIsVisible(id, preferences, detected));
}
