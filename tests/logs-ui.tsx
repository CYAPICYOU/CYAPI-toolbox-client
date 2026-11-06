import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CodexAnalysis } from '../src/app/CodexAnalysis';
import type { CodexAnalysisClient } from '../src/app/CodexAnalysis';
import { AgentLogAnalysis } from '../src/app/AgentLogAnalysis';
import type {
  AgentLogClient,
  AgentLogEvent,
  AgentLogSnapshot,
  LogStats,
} from '../src/lib/api/agentLogs';
import type { Analysis, AnalysisEvent } from '../src/lib/api/codexAnalysis';
import { Modal } from '../src/components/Primitives';
import { LogWindow } from '../src/app/LogWindow';
import '../src/app/styles.css';
import '../src/app/native.css';
import '../src/app/theme.css';
import '../src/app/usage-statistics.css';
import '../src/features/platform/platform.css';

// Synthetic transport addresses are documentation-only IP ranges.
const at = 1794000000000;
const long = 'long-path-segment-'.repeat(65);
const raw = Array.from({ length: 120 }, (_, i) => `record ${i}: ${long}`).join('\n');
const location = {
  sourceId: 'source',
  sourceRole: 'runtime',
  path: `C:/fixture/${long}/test.log`,
  position: 'line 1',
};
const requestIps = [{ ip: '192.0.2.8', port: 443, kind: 'remote' as const, source: 'remote_addr' }];
const codexEvent: AnalysisEvent = {
  id: 'event',
  time: at,
  kind: 'request',
  level: 'ERROR',
  target: 'fixture',
  threadId: 'session-fixture',
  model: 'test-model',
  summary: `请求失败 ${long}`,
  location,
  mirrors: [location],
  http: {
    requestIps,
    method: 'POST',
    url: 'https://example.invalid/v1/responses',
    scheme: 'https',
    host: 'example.invalid',
    path: '/v1/responses',
    status: 503,
    ok: false,
    timeout: false,
    connect: false,
    requestId: long,
  },
};
const codex: Analysis = {
  id: 'snapshot',
  generatedAt: at,
  since: 0,
  window: 0,
  codexHome: 'C:/fixture',
  config: {
    provider: 'test',
    model: 'test-model',
    baseUrl: 'https://example.invalid',
    expectedHost: 'example.invalid',
    expectedScheme: 'https',
    providers: [],
  },
  partial: false,
  mirrored: 0,
  eventCount: 2,
  sources: [
    {
      ...location,
      id: 'source',
      role: 'runtime',
      name: 'Fixture',
      format: 'SQLite',
      size: 1,
      walSize: 0,
      modifiedAt: at,
      status: 'available',
      records: 2,
      partial: false,
      note: '',
    },
  ],
  totals: {
    requests: 2,
    ok: 1,
    failed: 1,
    retries: 0,
    turnErrors: 0,
    warnings: 0,
    errors: 1,
    sessions: 1,
  },
  routes: [],
  sessions: [
    {
      id: 'session-fixture',
      title: '测试会话',
      cwd: 'C:/fixture',
      provider: 'test',
      model: 'test-model',
      origin: '',
      updatedAt: at,
      archived: false,
      requests: 2,
      failures: 1,
      retries: 0,
      turnErrors: 0,
      hosts: [],
      rolloutPath: '',
      routeStatus: 'unverified',
    },
  ],
  issues: [],
  notes: [],
  recent: [codexEvent],
};
const stats: LogStats = {
  responses: 2,
  responseErrors: 1,
  apiErrors: 0,
  retries: 0,
  toolCalls: 0,
  toolErrors: 0,
  compactions: 0,
  userTurns: 1,
  errors: 1,
  warnings: 0,
  usageRecords: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 },
};
const agentEvent: AgentLogEvent = {
  id: 'event',
  time: at,
  kind: 'response',
  level: 'ERROR',
  target: 'fixture',
  sessionId: 'session-fixture',
  model: 'test-model',
  provider: 'test',
  summary: codexEvent.summary,
  failed: true,
  status: 503,
  requestIps,
  requestId: long,
  usage: stats.tokens,
  location,
  mirrors: [location],
};
const agent: AgentLogSnapshot = {
  id: 'snapshot',
  workspace: 'claude',
  home: 'C:/fixture',
  generatedAt: at,
  since: 0,
  window: 0,
  partial: false,
  mirrored: 0,
  eventCount: 2,
  totals: stats,
  sessions: [
    {
      id: 'session-fixture',
      title: '测试会话',
      project: 'C:/fixture',
      model: 'test-model',
      provider: 'test',
      agent: '',
      updatedAt: at,
      stats,
    },
  ],
  models: [],
  sources: [
    {
      ...location,
      id: 'source',
      role: 'runtime',
      format: 'log',
      size: 1,
      walSize: 0,
      records: 2,
      status: 'available',
      partial: false,
      note: '',
    },
  ],
  issues: [],
  notes: [],
  recent: [agentEvent],
};

let failDetail = false;
let releaseDetail: (() => void) | undefined;
let holdDetail = false;
let analyzed = 0;
let exported: string | undefined;
let query: unknown;
let copied = '';
let failCopy = true;
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      if (failCopy) {
        failCopy = false;
        throw new Error('测试剪贴板失败');
      }
      copied = text;
    },
  },
});
const intervals = new Map<number, TimerHandler>();
const originalInterval = window.setInterval.bind(window);
window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  if (timeout === 15000) {
    intervals.set(9001, handler);
    return 9001;
  }
  return originalInterval(handler, timeout, ...args);
}) as typeof window.setInterval;
const originalClear = window.clearInterval.bind(window);
window.clearInterval = (id) => {
  if (typeof id === 'number') intervals.delete(id);
  originalClear(id);
};
async function detailGate() {
  if (holdDetail)
    await new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
  if (failDetail) {
    failDetail = false;
    throw new Error(`测试详情读取失败 ${long}`);
  }
}
const codexClient: CodexAnalysisClient = {
  available: true,
  analyze: async () => {
    analyzed++;
    return codex;
  },
  events: async (_, q, source, offset) => {
    query = { ...q, source };
    return {
      snapshotId: 'snapshot',
      events: [
        offset
          ? { ...codexEvent, id: 'second', http: { ...codexEvent.http!, requestIps: [] } }
          : codexEvent,
      ],
      total: 2,
      nextOffset: offset ? undefined : 1,
    };
  },
  detail: async () => {
    await detailGate();
    return { event: codexEvent, message: raw, span: long, note: '合成测试数据' };
  },
  session: async () => ({
    session: codex.sessions[0],
    source: codex.sources[0],
    turns: { started: 1, completed: 0, aborted: 1 },
    toolCalls: 0,
    events: [codexEvent],
    eventDetails: {},
    hasMore: false,
    note: '',
  }),
  export: async (_, id) => {
    exported = id;
    return { path: 'C:/fixture/report.json' };
  },
};
const agentClient: AgentLogClient = {
  available: true,
  analyze: async (workspace) => {
    analyzed++;
    return { ...agent, workspace };
  },
  events: async (_, __, q, offset) => {
    query = q;
    return {
      snapshotId: 'snapshot',
      events: [offset ? { ...agentEvent, id: 'second', requestIps: [] } : agentEvent],
      total: 2,
      nextOffset: offset ? undefined : 1,
    };
  },
  detail: async () => {
    await detailGate();
    return { event: agentEvent, evidence: { records: raw }, note: '合成测试数据' };
  },
  session: async () => ({
    session: agent.sessions[0],
    events: [agentEvent],
    children: [],
    hasMore: false,
    note: '',
  }),
  export: async (_, __, id) => {
    exported = id;
    return { path: 'C:/fixture/report.json' };
  },
};
const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(window.location.search);
const harness = params.get('harness') || 'codex';
function page() {
  return harness === 'codex' ? (
    <CodexAnalysis client={codexClient} />
  ) : (
    <AgentLogAnalysis
      key={harness}
      workspace={harness === 'claude' ? 'claude' : 'opencode'}
      client={agentClient}
    />
  );
}
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
async function click(label: string, scope?: ParentNode) {
  const b = button(label, scope);
  check(b, `missing button ${label}`);
  await act(async () => {
    b.click();
  });
}
async function select(label: string, value: string) {
  await act(async () => {
    const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function bounds() {
  const panel = document.querySelector<HTMLElement>('.modal')!;
  const r = panel.getBoundingClientRect();
  check(
    r.top >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
    'dialog outside viewport',
  );
  check(panel.scrollWidth <= panel.clientWidth + 1, 'dialog horizontal overflow');
  const body = panel.querySelector<HTMLElement>(
    '.ca-evidence, .u-price-form, .n-install-dialog, .n-config-body, .n-help, .n-restart-body, .pfx-key-dialog-body',
  )!;
  check(body.clientHeight > 0 && body.scrollHeight > body.clientHeight, 'body not scrollable');
  body.scrollTop = body.scrollHeight;
  check(
    body.scrollTop > 0 && body.scrollWidth <= body.clientWidth + 1,
    'body overflow containment',
  );
  const footer = panel.querySelector('.n-dialog-footer')!.getBoundingClientRect();
  check(footer.bottom <= innerHeight && footer.top >= 0, 'footer not reachable');
}
async function runChecks() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await act(async () => root.render(<StrictMode>{page()}</StrictMode>));
  check(document.querySelectorAll('.ca-metric').length === 3, 'overview too dense');
  check(
    [...document.querySelectorAll('.ca-tabs button')].map((e) => e.textContent).join('|') ===
      '概览|会话|模型活动|问题|全部事件|数据来源',
    'navigation differs',
  );
  check(
    document.querySelector('.ca-events')?.textContent?.includes('192.0.2.8'),
    'known IP hidden',
  );
  await click('自动刷新');
  failDetail = true;
  await click('查看');
  check(document.querySelector('[role="dialog"] [role="alert"]'), 'detail failure closed dialog');
  await click('重试');
  check(
    document.querySelectorAll('.ca-disclosure[open]').length === 0,
    'raw metadata open by default',
  );
  const before = analyzed;
  await act(async () => {
    for (const tick of intervals.values()) if (typeof tick === 'function') tick();
  });
  check(analyzed === before, 'auto refresh while inspecting');
  await click('复制详情');
  check(
    document.querySelector('.ca-detail-footer [role="alert"]'),
    'clipboard failure not visible',
  );
  await click('复制详情');
  check(
    copied.includes('192.0.2.8') && copied.includes('record 119'),
    'copy lost IP or full record',
  );
  await act(async () => {
    document.querySelectorAll<HTMLDetailsElement>('.ca-disclosure').forEach((e) => {
      e.open = true;
    });
  });
  bounds();
  const last = button('关闭', document.querySelector('.modal')!);
  last.focus();
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
  });
  check(
    document.activeElement === document.querySelector('.modal-header button'),
    'focus escaped modal',
  );
  await click('关闭');
  holdDetail = true;
  await click('查看');
  await click('关闭');
  await act(async () => {
    releaseDetail?.();
  });
  holdDetail = false;
  check(!document.querySelector('[role="dialog"]'), 'late detail reopened modal');
  await click('查看');
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  check(!document.querySelector('[role="dialog"]'), 'Escape did not close modal');
  await click('模型活动');
  check(
    !document.querySelector<HTMLDetailsElement>('.ca-advanced')!.open,
    'advanced filters open by default',
  );
  await act(async () => {
    document.querySelector<HTMLDetailsElement>('.ca-advanced')!.open = true;
  });
  await select('筛选日志来源', harness === 'codex' ? 'runtime' : 'source');
  check(
    document.querySelector('.ca-advanced summary')?.textContent?.includes('已选 1 项'),
    'hidden filter count',
  );
  await click('清除筛选');
  check(
    !Object.entries(query as object).some(
      ([key, value]) => !['kind', 'kinds'].includes(key) && value,
    ),
    'reset retained user filter',
  );
}
// The view kind is intentionally retained when clearing user-selected filters.
async function finishChecks() {
  await click('全部事件', document.querySelector('.ca-tabs')!);
  check(!Object.values(query as object).some(Boolean), 'filters leaked across views');
  await click('加载更多');
  check(document.querySelectorAll('.ca-events tbody tr').length === 2, 'pagination');
  check(
    document.querySelector('.ca-events')?.textContent?.includes('请求 IP：未记录'),
    'unknown IP not labelled',
  );
  await click('会话', document.querySelector('.ca-tabs')!);
  await click('导出会话报告');
  check(exported === 'session-fixture', 'wrong export scope');
  for (const className of [
    'u-price-form',
    'n-config-body',
    'n-install-dialog',
    'n-help',
    'n-restart-body',
    'pfx-key-dialog-body',
  ]) {
    const body = (
      <div className={className}>
        <p>{raw}</p>
        <pre>{raw}</pre>
      </div>
    );
    const footer = (
      <div className="n-dialog-footer">
        <button>保存</button>
      </div>
    );
    await act(async () =>
      root.render(
        <Modal title={`长标题 ${long}`} onClose={() => {}}>
          {className === 'u-price-form' || className === 'n-config-body' ? (
            <form>
              {body}
              {footer}
            </form>
          ) : (
            <>
              {body}
              {footer}
            </>
          )}
        </Modal>,
      ),
    );
    bounds();
  }
  await act(async () => root.render(<LogWindow onClose={() => {}} />));
  const drawer = document.querySelector('.d-log-window')!.getBoundingClientRect();
  check(
    drawer.left >= 0 &&
      drawer.right <= innerWidth &&
      drawer.top >= 0 &&
      drawer.bottom <= innerHeight,
    'drawer outside viewport',
  );
  await act(async () => root.render(page()));
  return `${harness} ${innerWidth}×${innerHeight}: passed`;
}
Object.assign(window, {
  runLogChecks: async () => {
    await runChecks();
    return finishChecks();
  },
});
root.render(<main style={{ padding: 16 }}>{page()}</main>);
