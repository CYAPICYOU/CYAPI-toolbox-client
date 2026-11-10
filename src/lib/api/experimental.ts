import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from './native';

export interface ExperimentalSettings {
  enabled: boolean;
}
const previewKey = 'cyapi.experimental.preview.v1';

export async function readExperimentalSettings(): Promise<ExperimentalSettings> {
  if (nativeAvailable) return invoke<ExperimentalSettings>('experimental_settings');
  return { enabled: localStorage.getItem(previewKey) === 'enabled' };
}

export async function saveExperimentalSettings(
  enabled: boolean,
  confirmed: boolean,
): Promise<ExperimentalSettings> {
  if (enabled && !confirmed) throw new Error('请先确认实验性功能的开发阶段风险');
  if (nativeAvailable)
    return invoke<ExperimentalSettings>('set_experimental_settings', { enabled, confirmed });
  localStorage.setItem(previewKey, enabled ? 'enabled' : 'disabled');
  return { enabled };
}
