import { invoke } from '@tauri-apps/api/core';
import { cyapiDownload, cyapiRequest, nativeAvailable, SERVER_URL, type HostedRoute } from '../../lib/api/native';
import type { WorkflowCatalog } from './library';

const SERVER = SERVER_URL.replace(/\/+$/, '');
export const PLATFORM_API = `${SERVER}/workflow/platform/api`;
// Native transport joins the request path onto the server origin, so it needs
// the same platform prefix the browser uses.
const PLATFORM_API_PATH = PLATFORM_API.slice(SERVER.length);
export const WORKFLOW_EDITOR_PATH = `${SERVER}/workflow/`;

export interface WorkspaceState {
  id: string;
  status: 'stopped' | 'starting' | 'running' | 'unknown';
  running: boolean;
  port: number | null;
  startedAt: number | null;
  lastActiveAt: number | null;
}

export interface Activation {
  user: { id: string; keyHint: string };
  workspace: WorkspaceState;
  workspaceCapacity: { maxConcurrent: number; running: number };
  backend: 'process' | 'comfyui' | 'docker' | 'remote';
  editor: { path: string; tokenTtlSeconds: number };
  billing?: {
    enabled: boolean;
    mode?: 'live' | 'simulate';
    model: string;
    priceUsd: number;
    currency: string;
  };
}

export type BillingRunStatus =
  'pending' | 'settling' | 'charged' | 'simulated' | 'unpaid' | 'failed' | 'cancelled' | 'unknown';

export interface BillingRun {
  id: string;
  promptId: string;
  status: BillingRunStatus;
  reason: string | null;
  priceUsd: number;
  currency: string;
  createdAt: number;
  finishedAt: number | null;
  chargedAt: number | null;
}

export interface BillingSummary {
  enabled: boolean;
  mode?: 'live' | 'simulate';
  model: string;
  priceUsd: number;
  currency: string;
  precheck: boolean;
  recent: BillingRun[];
}

export interface ModelList {
  object: string;
  data: { id: string; object?: string }[];
}

export interface NodeInstall {
  id: string;
  workspaceId: string;
  name: string;
  repo: string;
  ref: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  log: string;
  createdAt: number;
  finishedAt: number | null;
}

export class PlatformError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = 'request_failed') {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
  }
}

type RequestResponse<T> = { status: number; route: HostedRoute; body: T; text?: string };

async function readError(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return { message: `请求失败（${response.status}）`, code: 'request_failed' };
  try {
    const value = JSON.parse(text) as {
      error?: { code?: string; message?: string } | string;
    };
    if (value.error && typeof value.error === 'object') {
      return {
        message: value.error.message || `请求失败（${response.status}）`,
        code: value.error.code || 'request_failed',
      };
    }
    if (typeof value.error === 'string') return { message: value.error, code: 'request_failed' };
  } catch {
    // Plain text is still useful.
  }
  return { message: text.slice(0, 400), code: 'request_failed' };
}

function nativeError(status: number, body: unknown, text = '') {
  if (body && typeof body === 'object') {
    const value = body as { error?: { code?: string; message?: string } | string };
    if (value.error && typeof value.error === 'object') {
      return {
        message: value.error.message || `请求失败（${status}）`,
        code: value.error.code || 'request_failed',
      };
    }
    if (typeof value.error === 'string') return { message: value.error, code: 'request_failed' };
  }
  return { message: text.slice(0, 400) || `请求失败（${status}）`, code: 'request_failed' };
}

async function requestResponse<T>(
  path: string,
  {
    method = 'GET',
    key,
    body,
    signal,
    timeoutMs,
    base = PLATFORM_API_PATH,
  }: {
    method?: string;
    key?: string;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Server-root path prefix; the workflow API lives outside /workflow. */
    base?: string;
  } = {},
): Promise<RequestResponse<T>> {
  if (nativeAvailable) {
    let result: RequestResponse<T>;
    try {
      result = await cyapiRequest<T>(base + path, {
        method,
        key,
        body,
        signal,
        timeoutMs,
      });
    } catch (cause) {
      const message = (cause instanceof Error ? cause.message : String(cause))
        .replace(/^\s*(Error:\s*)+/i, '')
        .trim();
      if (/timeout|timed out|超时/i.test(message)) {
        throw new PlatformError(
          '等待 CYAPI 服务响应超时，工作区可能仍在后台启动，请稍后重试',
          0,
          'timeout',
        );
      }
      // Keep the native reason (which route failed and why); a blanket
      // "network error" hides the difference between a dead route, DNS
      // failure and a refused connection.
      throw new PlatformError(
        !message
          ? '无法连接 CYAPI 服务，请检查网络后重试'
          : message.startsWith('CYAPI')
            ? message.slice(0, 400)
            : `无法连接 CYAPI 服务：${message.slice(0, 400)}`,
        0,
        'network',
      );
    }
    if (result.status < 200 || result.status >= 300) {
      const error = nativeError(result.status, result.body, result.text);
      throw new PlatformError(error.message, result.status, error.code);
    }
    return result;
  }
  let response: Response;
  try {
    response = await fetch(SERVER + base + path, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new PlatformError('无法连接 CYAPI 服务，请检查网络后重试', 0, 'network');
  }
  if (!response.ok) {
    const error = await readError(response);
    throw new PlatformError(error.message, response.status, error.code);
  }
  return { status: response.status, route: 'cloudflare', body: (await response.json()) as T };
}

async function request<T>(
  path: string,
  {
    method = 'GET',
    key,
    body,
    signal,
    timeoutMs,
  }: {
    method?: string;
    key?: string;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  return (await requestResponse<T>(path, { method, key, body, signal, timeoutMs })).body;
}export const getActivation = (key: string) => request<Activation>('/workspace', { key });
export const recordActivity = (key: string) =>
  request<{ ok: boolean }>('/workspace/activity', { method: 'POST', key });
export const startWorkspace = (key: string) =>
  request<{ workspace: WorkspaceState; workspaceCapacity: Activation['workspaceCapacity'] }>(
    '/workspace/start',
    {
      method: 'POST',
      key,
      // A cold workspace starts a container and waits for ComfyUI to answer.
      timeoutMs: 180_000,
    },
  );
export const stopWorkspace = (key: string) =>
  request<{ workspace: WorkspaceState; workspaceCapacity: Activation['workspaceCapacity'] }>(
    '/workspace/stop',
    {
      method: 'POST',
      key,
      timeoutMs: 120_000,
    },
  );
export const restartWorkspace = (key: string) =>
  request<{ workspace: WorkspaceState; workspaceCapacity: Activation['workspaceCapacity'] }>(
    '/workspace/restart',
    {
      method: 'POST',
      key,
      timeoutMs: 180_000,
    },
  );
export const getWorkflowCatalog = async () => {
  const catalog = await request<WorkflowCatalog>('/public/catalog');
  if (
    catalog.version !== 1 ||
    !Array.isArray(catalog.categories) ||
    !Array.isArray(catalog.items) ||
    !catalog.items.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        item.form &&
        Array.isArray(item.steps) &&
        typeof item.input === 'string' &&
        typeof item.output === 'string',
    )
  ) {
    throw new PlatformError('服务端工作流目录格式不兼容，请更新服务后重试', 0, 'invalid_catalog');
  }
  return catalog;
};
export const editorToken = (
  key: string,
  document?: Record<string, unknown>,
  signal?: AbortSignal,
) =>
  requestResponse<{ url: string; expiresIn: number }>('/workspace/editor-token', {
    method: 'POST',
    key,
    body: document ? { document } : undefined,
    signal,
    // This call waits for the workspace; the native default is only 15s.
    timeoutMs: 180_000,
  }).then((response) => ({ ...response.body, route: response.route }));
export const listModels = (key: string) => request<ModelList>('/models', { key });
export const getUsage = (key: string) => request<unknown>('/usage', { key });
export const getBilling = (key: string, limit = 10) =>
  request<BillingSummary>(`/billing?limit=${limit}`, { key });
export const listNodes = (key: string) => request<{ data: NodeInstall[] }>('/nodes', { key });
export const installNode = (key: string, repo: string, ref?: string) =>
  request<{ data: NodeInstall }>('/nodes/install', {
    method: 'POST',
    key,
    body: { repo, ...(ref ? { ref } : {}) },
  });
export const nodeInstall = (key: string, id: string) =>
  request<{ data: NodeInstall }>(`/nodes/installs/${encodeURIComponent(id)}`, { key });
export const removeNode = (key: string, name: string) =>
  request<{ data: { name: string; removed: boolean } }>(`/nodes/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    key,
  });

// ---------------------------------------------------------------------------
// Real workflow execution. These routes live at the server root (`/api/workflows`)
// and submit through Bridge, so the client no longer simulates tasks locally.
// ---------------------------------------------------------------------------
const WORKFLOW_API_PATH = '/api/workflows';

export type WorkflowTaskStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'provider_failed_charged'
  | 'provider_unknown'
  | 'interrupted';

export interface WorkflowTaskOutput {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'mesh' | 'text' | string;
  title?: string;
  url: string;
  download: string;
  bytes?: number;
  storageType?: string;
  role?: 'preview' | 'file' | 'temporary';
}

export interface WorkflowTask {
  id: string;
  draftId: string;
  name: string;
  source?: 'editor';
  description: string;
  status: WorkflowTaskStatus;
  message?: string;
  outputs: WorkflowTaskOutput[];
  createdAt: number;
  finishedAt?: number;
  billing?: { mode: string; status: string; amount: number; unit: string };
}

export interface WorkflowDraft {
  id: string;
  templateId: string;
  name: string;
  revision: number;
  description: string;
}

export interface WorkflowQuote {
  mode: 'real-provider' | 'test-adapter';
  draftId: string;
  revision: number;
  amount: number;
  unit: string;
  items?: unknown[];
  bridgeQuote?: unknown;
}

async function workflowRequest<T>(
  path: string,
  options: {
    method?: string;
    key?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  return (await requestResponse<T>(path, { ...options, base: WORKFLOW_API_PATH })).body;
}

export const listWorkflowTasks = (key: string, limit = 50) =>
  workflowRequest<{ tasks: WorkflowTask[]; total: number }>(`/tasks?limit=${limit}`, { key });
export const getWorkflowTask = (key: string, id: string) =>
  workflowRequest<WorkflowTask>(`/tasks/${encodeURIComponent(id)}`, { key });
export const cancelWorkflowTask = (key: string, id: string) =>
  workflowRequest<WorkflowTask>(`/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    key,
    body: {},
  });
export const createWorkflowDraft = (key: string, templateId: string) =>
  workflowRequest<WorkflowDraft>('/drafts', { method: 'POST', key, body: { templateId } });
export const saveWorkflowDraft = (
  key: string,
  id: string,
  input: { revision: number; description: string },
) =>
  workflowRequest<WorkflowDraft>(`/drafts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    key,
    body: input,
  });
export const quoteWorkflowDraft = (key: string, id: string) =>
  workflowRequest<WorkflowQuote>(`/drafts/${encodeURIComponent(id)}/quote`, { key });
export const runWorkflowDraft = (
  key: string,
  id: string,
  revision: number,
  quote: WorkflowQuote,
) =>
  workflowRequest<WorkflowTask>(`/drafts/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    key,
    body: { revision, quote },
    // Bridge submits the provider call before answering.
    timeoutMs: 120_000,
  });

/** Private result URLs need the Key; return an object URL for the renderer. */
export async function downloadWorkflowArtifact(key: string, path: string): Promise<string> {
  if (nativeAvailable) return cyapiDownload(path, key);
  let response: Response;
  try {
    response = await fetch(SERVER + path, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new PlatformError('无法连接 CYAPI 服务，请检查网络后重试', 0, 'network');
  }
  if (!response.ok) throw new PlatformError('结果下载失败或已过期', response.status);
  return URL.createObjectURL(await response.blob());
}

/** Opens the hosted ComfyUI editor in a separate desktop WebView. */
export async function openEditorWindow(url: string, route: HostedRoute = 'cloudflare') {
  if (nativeAvailable) {
    try {
      await invoke('open_workflow_editor', { url, route });
    } catch (cause) {
      // Tauri rejects with a plain string; surface it as a real Error so the
      // caller can show the reason instead of a generic "please retry".
      throw cause instanceof Error
        ? cause
        : new Error(String(cause).replace(/^\s*(Error:\s*)+/i, ''));
    }
    return;
  }
  // Keep a handle just long enough to detect popup blocking. Remove the opener
  // before navigating, so the remote editor cannot reach the local workbench.
  const popup = window.open('about:blank', '_blank');
  if (!popup) throw new Error('浏览器阻止了编辑器窗口，请允许弹出窗口后重试。');
  popup.opener = null;
  popup.location.replace(url);
}
