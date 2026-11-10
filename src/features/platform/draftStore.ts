/** Local draft form state. Real runs are submitted to the server workflow API. */
import type { WorkflowTemplate } from './library.ts';

export interface LocalWorkflowDraft {
  id: string;
  kind: WorkflowTemplate['kind'];
  title: string;
  prompt: string;
  fileName: string;
  fileData: string;
  files?: { name: string; data: string }[];
  maskName?: string;
  maskData?: string;
  params?: Record<string, string | number | boolean>;
  updatedAt: number;
  template?: WorkflowTemplate;
}
export interface WorkflowDraftState {
  drafts: LocalWorkflowDraft[];
}
// Keep the existing storage key so upgrading does not discard saved drafts.
const DRAFT_STORAGE = 'cyapi.workflows.local-mock.v1';

export function validateDraft(draft: LocalWorkflowDraft) {
  if (draft.template) {
    if (draft.template.form.prompt?.required && !draft.prompt.trim()) return '请输入文字内容。';
    if (draft.template.form.file?.required && !draft.fileData && !draft.files?.length) return '请选择素材文件。';
    if (draft.template.form.mask?.required && !draft.maskData) return '请选择蒙版文件。';
    return '';
  }
  if (draft.kind !== 'transcription' && !draft.prompt.trim()) return '请输入文字内容。';
  if ((draft.kind === 'image-reference' || draft.kind === 'transcription') && !draft.fileData)
    return '请选择素材文件。';
  return '';
}

export function loadDraftState(): WorkflowDraftState {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || 'null');
    if (!value || !Array.isArray(value.drafts)) return { drafts: [] };
    return { drafts: value.drafts };
  } catch {
    return { drafts: [] };
  }
}

export function saveDraftState(state: WorkflowDraftState) {
  try {
    localStorage.setItem(DRAFT_STORAGE, JSON.stringify(state));
  } catch {
    throw new Error('本地存储空间不足，未能保存。请减少素材大小或删除旧记录。');
  }
}
