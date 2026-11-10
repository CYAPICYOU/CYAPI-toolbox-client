export type WorkflowGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
>;
export interface WorkflowTemplate {
  id: string;
  title: string;
  description: string;
  category: string;
  version: string;
  source: 'server' | 'personal';
  kind: 'image' | 'image-reference' | 'video' | 'speech' | 'transcription' | 'text';
  input: string;
  output: string;
  steps: string[];
  form: {
    prompt?: { label: string; placeholder?: string; required: boolean };
    file?: { label: string; accept: string; required: boolean; multiple?: boolean; maxFiles?: number };
    mask?: { label: string; accept: string; required: boolean };
    markup?: { label: string; accept: string; required: boolean };
    options?: WorkflowFormOption[];
  };
  apiGraph?: WorkflowGraph;
  workflow?: Record<string, unknown>;
  execution: 'preview';
  transport?: 'bridge' | 'worker';
}

export interface WorkflowFormOption {
  key: string;
  label: string;
  default?: string | number | boolean;
  kind: 'toggle' | 'select' | 'number' | 'text';
  choices?: { value: string; label: string }[];
}
export interface WorkflowCatalog {
  version: number;
  categories: { id: string; label: string }[];
  items: WorkflowTemplate[];
}

const PERSONAL_STORAGE = 'cyapi.workflows.personal.v1';
export function loadPersonalWorkflows(): WorkflowTemplate[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PERSONAL_STORAGE) || '[]');
    return Array.isArray(value)
      ? value.filter(
          (item) =>
            item?.source === 'personal' &&
            typeof item.id === 'string' &&
            typeof item.title === 'string' &&
            item.form &&
            Array.isArray(item.steps),
        )
      : [];
  } catch {
    return [];
  }
}
export function savePersonalWorkflows(items: WorkflowTemplate[]) {
  try {
    localStorage.setItem(PERSONAL_STORAGE, JSON.stringify(items));
  } catch {
    throw new Error('存储空间不足，未能保存工作流。');
  }
}

export function importWorkflow(source: string, filename: string): WorkflowTemplate {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('文件不是有效的 JSON，请选择 ComfyUI 工作流文件。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('文件中没有可识别的 ComfyUI 工作流。');
  const data = value as Record<string, unknown>;
  const candidate = data.apiGraph ?? data.prompt ?? data;
  const graph =
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as WorkflowGraph)
      : null;
  const validGraph =
    graph &&
    Object.keys(graph).length > 0 &&
    Object.values(graph).every(
      (node) =>
        node &&
        typeof node.class_type === 'string' &&
        node.inputs &&
        typeof node.inputs === 'object' &&
        !Array.isArray(node.inputs),
    );
  const canvas = Array.isArray(data.nodes)
    ? data
    : data.workflow &&
        typeof data.workflow === 'object' &&
        Array.isArray((data.workflow as Record<string, unknown>).nodes)
      ? (data.workflow as Record<string, unknown>)
      : null;
  if (!validGraph && !canvas)
    throw new Error('不支持此文件结构，请导出 ComfyUI 工作流或 API 格式的 JSON。');
  return {
    id: crypto.randomUUID(),
    title:
      typeof data.name === 'string'
        ? data.name.slice(0, 80)
        : filename.replace(/\.json$/i, '').slice(0, 80) || '导入的工作流',
    description: '导入的 ComfyUI 工作流，可查看节点并在编辑器中继续编辑。',
    category: 'personal',
    source: 'personal',
    version: '1.0.0',
    kind: 'text',
    input: '在 ComfyUI 中配置节点输入',
    output: '由工作流节点决定',
    steps: ['检查节点与输入', '在 ComfyUI 中配置', '运行并查看结果'],
    form: {},
    execution: 'preview',
    ...(validGraph ? { apiGraph: graph } : {}),
    ...(canvas ? { workflow: canvas } : {}),
  };
}

/** Fill only declared text widgets, never linked node inputs. */
export function workflowDocument(template: WorkflowTemplate, prompt = '') {
  // Imported canvases carry positions, groups and widget settings that cannot
  // be reconstructed losslessly from the API graph.
  if (template.workflow && !template.form.prompt) return structuredClone(template.workflow);
  if (!template.apiGraph) return template.workflow;
  const graph = structuredClone(template.apiGraph);
  if (prompt)
    for (const node of Object.values(graph)) {
      for (const name of ['prompt', 'text'])
        if (typeof node.inputs[name] === 'string') node.inputs[name] = prompt;
    }
  // Server templates contain the Bridge node only. Expand the editor graph
  // without changing the published graph used by the direct Bridge runner.
  if (template.source === 'server' && ['gpt-image-25-generate', 'gpt-image-25-edit'].includes(template.id)) {
    const entry = Object.entries(graph).find(([, node]) => node.class_type.startsWith('CYAPI_GPTImage25'));
    if (entry) {
      const [id, node] = entry;
      let next = Math.max(0, ...Object.keys(graph).map(key => Number(key) || 0)) + 1;
      if (template.id === 'gpt-image-25-edit' && !Array.isArray(node.inputs.image_1)) {
        const load = String(next++);
        graph[load] = { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: '基准图 / 上一轮结果（请选择图片）' } };
        node.inputs.image_1 = [load, 0];
        const mask = String(next++);
        graph[mask] = { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: '可选蒙版 PNG：将 MASK 连到 mask' } };
        const overlay = String(next++);
        graph[overlay] = { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: '可选透明标注 PNG：选择图片后连接标注输出' } };
        const combine = String(next++);
        graph[combine] = { class_type: 'CYAPI_MarkupFromImage', inputs: { image: [overlay, 0], mask: [overlay, 1] }, _meta: { title: '合并标注透明通道（连到 markup）' } };
      }
      graph[String(next)] = { class_type: 'SaveImage', inputs: { images: [id, 0], filename_prefix: 'CYAPI' }, _meta: { title: '保存并预览生成结果' } };
    }
  }
  return { prompt: graph };
}
