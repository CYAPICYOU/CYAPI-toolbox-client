import { invoke } from '@tauri-apps/api/core';
import {
  cyapiDownload,
  cyapiRequest,
  nativeAvailable,
  SERVER_URL,
  type HostedRoute,
} from '../../lib/api/native';
import type { WorkflowCatalog } from './library';

const SERVER = SERVER_URL.replace(/\/+$/, '');
export const PLATFORM_API = `${SERVER}/workflow/platform/api`;
// Native transport joins the request path onto the server origin, so it needs
// the same platform prefix the browser uses.
const PLATFORM_API_PATH = PLATFORM_API.slice(SERVER.length);

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
  try {
    return nativeError(response.status, JSON.parse(text), text);
  } catch {
    return nativeError(response.status, null, text);
  }
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
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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
      signal: timeoutMs
        ? signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
        : signal,
    });
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Error && cause.name === 'TimeoutError')
      throw new PlatformError('等待 CYAPI 服务响应超时，请稍后重试', 0, 'timeout');
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
}
export const getActivation = (key: string) => request<Activation>('/workspace', { key });
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

/** Public example images use the normal server route, never a user's Key. */
export async function downloadWorkflowExampleImage(path: string): Promise<string> {
  if (nativeAvailable) return cyapiDownload(path, '', { maxBytes: 3 * 1024 * 1024, timeoutMs: 30_000 });
  const response = await fetch(SERVER + path, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('案例图片加载失败');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/') || blob.size > 3 * 1024 * 1024) throw new Error('案例图片不可用');
  return URL.createObjectURL(blob);
}
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

// ---------------------------------------------------------------------------
// Real workflow execution. These routes live at the server root (`/api/workflows`)
// and submit complete graphs to Worker ComfyUI.
// ---------------------------------------------------------------------------
const WORKFLOW_API_PATH = '/api/workflows';

export interface PreparedWorkflowImage {
  id: string;
  type: string;
  width: number;
  height: number;
  originalBytes: number;
  bytes: number;
  changed: boolean;
  resized: boolean;
}

export async function removeUnsubmittedWorkflowDraft(key: string, id: string): Promise<void> {
  await requestResponse(`/drafts/${encodeURIComponent(id)}`, { method: 'DELETE', key, base: WORKFLOW_API_PATH });
}

export async function removeWorkflowUpload(key: string, id: string): Promise<void> {
  await requestResponse(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', key, base: WORKFLOW_API_PATH });
}

/** Browser Blob upload avoids JSON/Base64 and keeps each request bounded. */
export async function uploadPreparedWorkflowImage(key: string, image: Blob, options: {
  kind?: 'image' | 'mask' | 'markup'; overlay?: Blob; allowCompression?: boolean; allowResize?: boolean; signal?: AbortSignal;
} = {}): Promise<{ image: PreparedWorkflowImage; overlay?: PreparedWorkflowImage }> {
  const kind = options.kind ?? 'image';
  if (options.overlay && kind === 'image') throw new Error('成组上传需要蒙版或标注类型。');
  const params = new URLSearchParams({ kind });
  if (options.allowCompression) params.set('allowCompression', '1');
  if (options.allowResize) params.set('allowResize', '1');
  if (options.overlay) {
    params.set('imageBytes', String(image.size));
    params.set('overlayBytes', String(options.overlay.size));
  }
  const response = await fetch(`${SERVER}${WORKFLOW_API_PATH}/uploads/${options.overlay ? 'prepared-pair' : 'prepared'}?${params}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`,
      'Content-Type': options.overlay ? 'application/octet-stream' : image.type },
    body: options.overlay ? new Blob([image, options.overlay], { type: 'application/octet-stream' }) : image,
    credentials: 'omit', redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new PlatformError(error.message, response.status, error.code);
  }
  const result = await response.json();
  return options.overlay ? result : { image: result };
}

export type WorkflowTaskStatus =
  | 'created'
  | 'charging'
  | 'charge_rejected'
  | 'charge_unknown'
  | 'provider_submitting'
  | 'provider_running'
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
  sourceNode?: { id: string; type?: string; title?: string };
}

export interface WorkflowTask {
  id: string;
  draftId: string;
  name: string;
  source?: 'editor';
  mode?: string;
  description: string;
  status: WorkflowTaskStatus;
  message?: string;
  outputs: WorkflowTaskOutput[];
  createdAt: number;
  finishedAt?: number;
  billing?: { mode: string; status: string; amount: number; unit: string };
}

export interface WorkflowTaskLog {
  id: number;
  at: number;
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowTaskLogPage {
  taskId: string;
  status: WorkflowTaskStatus;
  entries: WorkflowTaskLog[];
  cursor: number;
  truncated: boolean;
}

export interface WorkflowDraft {
  id: string;
  templateId: string;
  name: string;
  revision: number;
  description: string;
}

export interface WorkflowQuote {
  mode: 'worker' | 'real-provider';
  draftId: string;
  revision: number;
  amount: number;
  unit: string;
  items: { nodeId: string; title?: string; classType: string; amount: number; unit: string; priceDetails?: unknown }[];
  runFee?: number;
  bridgeQuote?: Record<string, unknown>;
}

async function workflowRequest<T>(
  path: string,
  options: {
    method?: string;
    key?: string;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  return (await requestResponse<T>(path, { ...options, base: WORKFLOW_API_PATH })).body;
}

export const listWorkflowTasks = (key: string, limit = 50, signal?: AbortSignal) =>
  workflowRequest<{ tasks: WorkflowTask[]; total: number }>(`/tasks?limit=${limit}`, {
    key,
    signal,
    timeoutMs: 30_000,
  });
export const getWorkflowTaskLogs = (key: string, id: string, after = 0, signal?: AbortSignal) =>
  workflowRequest<WorkflowTaskLogPage>(`/tasks/${encodeURIComponent(id)}/logs?after=${after}`, {
    key,
    signal,
    timeoutMs: 15_000,
  });
export const getWorkflowPriceCatalog = () =>
  workflowRequest<unknown>('/catalog', { timeoutMs: 30_000 });
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
  input: {
    revision: number;
    description: string;
    references?: string[];
    mask?: string | null;
    markup?: string | null;
    params?: Record<string, string | number | boolean>;
  },
) =>
  workflowRequest<WorkflowDraft>(`/drafts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    key,
    body: input,
  });
export const quoteWorkflowDraft = (key: string, id: string) =>
  workflowRequest<WorkflowQuote>(`/drafts/${encodeURIComponent(id)}/pipeline-quote`, {
    key,
    timeoutMs: 180_000,
  });
export const quoteBridgeDraft = (key: string, id: string) =>
  workflowRequest<WorkflowQuote>(`/drafts/${encodeURIComponent(id)}/quote`, {
    key,
    timeoutMs: 180_000,
  });
export const runWorkflowDraft = (key: string, id: string, revision: number, quote: WorkflowQuote) =>
  workflowRequest<WorkflowTask>(`/drafts/${encodeURIComponent(id)}/pipeline-run`, {
    method: 'POST',
    key,
    body: { revision, quote },
    timeoutMs: 180_000,
  });
export const runBridgeDraft = (key: string, id: string, revision: number, quote: WorkflowQuote) =>
  workflowRequest<WorkflowTask>(`/drafts/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    key,
    body: { revision, quote },
    timeoutMs: 180_000,
  });

export async function uploadWorkflowAsset(key: string, dataUrl: string, kind?: 'mask' | 'markup', preserveAlpha = false) {
  const match = /^data:([^;,]+)(?:;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match || !match[2]) throw new PlatformError('素材数据无效，请重新选择文件', 400, 'invalid_upload');
  const data = match[2].replace(/\s/g, '');
  return workflowRequest<{ id: string }>('/uploads/base64', {
    method: 'POST',
    key,
    body: { type: match[1], data, ...(kind ? { kind } : {}), ...(preserveAlpha ? { preserveAlpha: true } : {}) },
    timeoutMs: 180_000,
  });
}

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
