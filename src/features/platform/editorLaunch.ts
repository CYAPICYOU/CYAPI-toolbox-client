export type EditorLaunchPhase = 'starting' | 'opening' | 'opened' | 'failed';
export type EditorLaunchRoute = 'beijing' | 'hongkong' | 'cloudflare';

export interface EditorLaunchState {
  operationId: string;
  phase: EditorLaunchPhase;
  title: string;
  startedAt: number;
  finishedAt: number | null;
  error: string;
}

export const editorLaunchPending = (state: EditorLaunchState | null) =>
  state?.phase === 'starting' || state?.phase === 'opening';

/** A single background launch, independent of navigation and other page actions.
 * Credentials and one-shot URLs are never included in the published UI state.
 */
export function createEditorLauncher({
  token,
  open,
  onChange,
  onEvent = () => {},
  now = Date.now,
  timeoutMs = 180_000,
}: {
  token: (
    key: string,
    document: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ url: string; route?: EditorLaunchRoute }>;
  open: (url: string, route?: EditorLaunchRoute) => Promise<void>;
  onChange: (state: EditorLaunchState | null) => void;
  onEvent?: (
    operationId: string,
    phase: EditorLaunchPhase | 'cancelled',
    elapsedSeconds: number,
  ) => void;
  now?: () => number;
  timeoutMs?: number;
}) {
  let current: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    operationId: string;
    startedAt: number;
  } | null = null;
  let last: { key: string; title: string; document: Record<string, unknown> } | null = null;

  async function launch(key: string, title: string, document: Record<string, unknown>) {
    // This lock is synchronous, so even two clicks before React rerenders coalesce.
    if (current) return false;
    last = { key, title, document: structuredClone(document) };
    const input = last;
    const controller = new AbortController();
    const operationId = `workflow-${crypto.randomUUID()}`;
    const startedAt = now();
    const operation = {
      controller,
      timer: setTimeout(() => controller.abort(), timeoutMs),
      operationId,
      startedAt,
    };
    current = operation;
    const publish = (phase: EditorLaunchPhase, error = '') => {
      if (current !== operation) return;
      onChange({
        operationId,
        phase,
        title,
        startedAt,
        finishedAt: phase === 'opened' || phase === 'failed' ? now() : null,
        error,
      });
      onEvent(operationId, phase, Math.max(0, Math.floor((now() - startedAt) / 1000)));
    };
    publish('starting');
    try {
      const session = await token(input.key, input.document, controller.signal);
      if (current !== operation) return false;
      if (controller.signal.aborted) throw new Error('timeout');
      clearTimeout(operation.timer);
      publish('opening');
       await open(session.url, session.route);
      if (current !== operation) return false;
      publish('opened');
      // Retrying must request a fresh token, not reuse the consumed URL.
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : String(cause).replace(/^\s*(Error:\s*)+/i, '');
      publish(
        'failed',
        controller.signal.aborted
          ? '等待 ComfyUI 响应超时，服务可能仍在后台启动。请稍后重试，不会删除工作流。'
          : message || '打开 ComfyUI 失败，请重试。',
      );
      return false;
    } finally {
      clearTimeout(operation.timer);
      if (current === operation) current = null;
    }
  }

  return {
    launch,
    retry() {
      return last ? launch(last.key, last.title, last.document) : Promise.resolve(false);
    },
    reset() {
      const operation = current;
      current = null;
      last = null;
      if (operation) {
        clearTimeout(operation.timer);
        operation.controller.abort();
        onEvent(
          operation.operationId,
          'cancelled',
          Math.max(0, Math.floor((now() - operation.startedAt) / 1000)),
        );
      }
      onChange(null);
    },
  };
}
