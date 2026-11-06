import { useCallback, useEffect, useRef, useState } from 'react';
import { listWorkflowTasks, type WorkflowTask } from './api';
import { pollResource } from './polling';
import { errorText, taskActive } from './taskState';

export function useWorkflowTasks(activeKey: string, enabled: boolean) {
  const [state, setState] = useState({
    key: '',
    tasks: [] as WorkflowTask[],
    error: '',
    loading: false,
  });
  const poller = useRef<ReturnType<typeof pollResource> | null>(null);
  useEffect(() => {
    if (!activeKey || !enabled) return;
    setState((current) => ({
      key: activeKey,
      tasks: current.key === activeKey ? current.tasks : [],
      error: '',
      loading: true,
    }));
    const current = pollResource({
      request: (signal) => listWorkflowTasks(activeKey, 50, signal),
      onValue: (result) =>
        setState({ key: activeKey, tasks: result.tasks, error: '', loading: false }),
      onError: (cause) =>
        setState((state) => ({ ...state, error: errorText(cause), loading: false })),
      // Idle polling also discovers tasks started in the separate editor window.
      delay: (result) => (result?.tasks.some((task) => taskActive(task.status)) ? 2500 : 10000),
    });
    poller.current = current;
    return () => {
      current.dispose();
      poller.current = null;
    };
  }, [activeKey, enabled]);
  const refresh = useCallback(() => poller.current?.refresh() ?? Promise.resolve(), []);
  return {
    tasks: state.key === activeKey ? state.tasks : [],
    error: state.key === activeKey ? state.error : '',
    loading: enabled && Boolean(activeKey) && (state.key !== activeKey || state.loading),
    refresh,
  };
}
