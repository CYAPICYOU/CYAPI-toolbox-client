import type { WorkflowTask } from './api.ts';
import type { WorkflowTemplate } from './library.ts';

export interface TaskParameter {
  key: string;
  label: string;
  value: string;
}

// Catalog options carry their own labels; this only covers parameters from
// older tasks whose template is no longer published.
const FALLBACK_LABELS: Record<string, string> = {
  size: '尺寸',
  quality: '质量',
  n: '数量',
  background: '背景',
  modelVariant: '模型版本',
  seed: '随机种子',
  steps: '步数',
  cfg: 'CFG',
  fps: '帧率',
  duration: '时长',
  aspect_ratio: '画面比例',
  resolution: '分辨率',
  num_frames: '帧数',
};

function displayValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

/**
 * Merge the applied options with the catalog defaults so a result shows the
 * parameters that were actually submitted, not only the ones the user changed.
 */
export function taskParameters(
  task: Pick<WorkflowTask, 'params'>,
  template?: WorkflowTemplate,
): TaskParameter[] {
  const applied = task.params ?? {};
  const options = template?.form?.options ?? [];
  const result: TaskParameter[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const raw = Object.hasOwn(applied, option.key) ? applied[option.key] : option.default;
    const value = displayValue(raw);
    if (!value) continue;
    seen.add(option.key);
    result.push({
      key: option.key,
      label: option.label || FALLBACK_LABELS[option.key] || option.key,
      value: option.choices?.find((choice) => String(choice.value) === String(raw))?.label ?? value,
    });
  }
  for (const [key, raw] of Object.entries(applied)) {
    if (seen.has(key)) continue;
    const value = displayValue(raw);
    if (!value) continue;
    result.push({ key, label: FALLBACK_LABELS[key] ?? key, value });
  }
  return result;
}
