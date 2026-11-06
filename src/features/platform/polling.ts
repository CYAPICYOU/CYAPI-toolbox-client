/** Serial polling: never overlap requests; disposing invalidates late responses. */
export function pollResource<T>({
  request,
  onValue,
  onError,
  delay,
}: {
  request: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
  delay: (value: T | undefined) => number | null;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let value: T | undefined;
  function refresh(): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    pending = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) return;
        const next = await request(controller.signal);
        if (!controller.signal.aborted) {
          value = next;
          onValue(next);
        }
      } catch (error) {
        if (!controller.signal.aborted) onError(error);
      } finally {
        pending = undefined;
        if (!controller.signal.aborted) {
          const ms = delay(value);
          if (ms !== null) timer = setTimeout(() => void refresh(), ms);
        }
      }
    });
    return pending;
  }
  void refresh();
  return {
    refresh,
    dispose() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
