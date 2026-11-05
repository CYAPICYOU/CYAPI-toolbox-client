/** Local draft form state. Real runs are submitted to the server workflow API. */
import type { WorkflowTemplate } from './library.ts';

export type MockKind = WorkflowTemplate['kind'];
export interface MockDraft {
  id: string;
  kind: MockKind;
  title: string;
  prompt: string;
  fileName: string;
  fileData: string;
  updatedAt: number;
  template?: WorkflowTemplate;
}
export interface MockState {
  drafts: MockDraft[];
}
export const MOCK_STORAGE = 'cyapi.workflows.local-mock.v1';
export const EMPTY_MOCK: MockState = { drafts: [] };

export function validateDraft(draft: MockDraft) {
  if (draft.template) {
    if (draft.template.form.prompt?.required && !draft.prompt.trim()) return '请输入文字内容。';
    if (draft.template.form.file?.required && !draft.fileData) return '请选择素材文件。';
    return '';
  }
  if (draft.kind !== 'transcription' && !draft.prompt.trim()) return '请输入文字内容。';
  if ((draft.kind === 'image-reference' || draft.kind === 'transcription') && !draft.fileData)
    return '请选择素材文件。';
  return '';
}

export function loadMockState(): MockState {
  try {
    const value = JSON.parse(localStorage.getItem(MOCK_STORAGE) || 'null');
    if (!value || !Array.isArray(value.drafts)) return { drafts: [] };
    return { drafts: value.drafts };
  } catch {
    return { drafts: [] };
  }
}

export function saveMockState(state: MockState) {
  try {
    localStorage.setItem(MOCK_STORAGE, JSON.stringify(state));
  } catch {
    throw new Error('本地存储空间不足，未能保存。请减少素材大小或删除旧记录。');
  }
}
