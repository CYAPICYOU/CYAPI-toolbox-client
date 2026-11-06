import type { WorkflowTaskStatus } from './api.ts';

export const taskStatusLabel: Record<WorkflowTaskStatus, string> = {
  created: '已创建',
  charging: '扣费中',
  charge_rejected: '扣费失败',
  charge_unknown: '扣费待核对',
  provider_submitting: '提交至 AI 服务',
  provider_running: '生成中',
  submitting: '提交中',
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  provider_failed_charged: '上游失败（已扣费）',
  provider_unknown: '结果待核对',
  interrupted: '已中断',
};

export const taskActive = (status: WorkflowTaskStatus) =>
  [
    'created',
    'charging',
    'provider_submitting',
    'provider_running',
    'submitting',
    'queued',
    'running',
  ].includes(status);

export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string' && error.trim()
      ? error
      : '操作失败，请稍后重试';
