/** Local draft form state. Real runs are submitted to the server workflow API. */
import type { WorkflowTemplate } from './library.ts';

export interface LocalWorkflowDraft {
  id: string;
  kind: WorkflowTemplate['kind'];
  title: string;
  prompt: string;
  fileName: string;
  fileData: string;
  files?: { name: string; data: string; blob?: Blob }[];
  maskName?: string;
  maskData?: string;
  maskBlob?: Blob;
  markupName?: string;
  markupData?: string;
  markupBlob?: Blob;
  blobDraft?: boolean;
  blobDraftId?: string;
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
    if (draft.template.form.markup?.required && !draft.markupData) return '请选择标注层文件。';
    if (draft.maskData && draft.markupData) return '蒙版与标注层不能同时使用。';
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
    const drafts = state.drafts.map(draft => ({ ...draft,
      fileData: draft.files?.[0]?.blob ? '' : draft.fileData,
      files: draft.files?.map(({ name, data, blob }) => ({ name, data: blob ? '' : data })),
      maskData: draft.maskBlob ? '' : draft.maskData,
      markupData: draft.markupBlob ? '' : draft.markupData,
      maskBlob: undefined, markupBlob: undefined,
      blobDraft: draft.blobDraft || draft.files?.some(file => file.blob) || draft.maskBlob || draft.markupBlob ? true : undefined,
    }));
    localStorage.setItem(DRAFT_STORAGE, JSON.stringify({ drafts }));
  } catch {
    throw new Error('本地存储空间不足，未能保存。请减少素材大小或删除旧记录。');
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cyapi-workflow-draft-blobs', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地图片存储。'));
    request.onblocked = () => reject(new Error('本地图片存储正被其他窗口占用。'));
  });
}

export async function storeBlobDraft(draft: LocalWorkflowDraft, storageId = draft.id): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ files: draft.files?.map(({ name, data, blob }) => ({ name, data: blob ? '' : data, blob })),
        maskBlob: draft.maskBlob, markupBlob: draft.markupBlob }, storageId);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('保存图片失败。'));
    });
  } finally { db.close(); }
}

export async function loadBlobDraft(draft: LocalWorkflowDraft): Promise<LocalWorkflowDraft> {
  if (!draft.blobDraft) return draft;
  const db = await database();
  try {
    const value = await new Promise<Pick<LocalWorkflowDraft, 'files' | 'maskBlob' | 'markupBlob'> | undefined>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(draft.blobDraftId ?? draft.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!value) throw new Error('草稿图片未找到，请重新选择素材。');
    const files = value.files?.map(file => ({ ...file, data: file.blob ? URL.createObjectURL(file.blob) : file.data }));
    return { ...draft, files, fileData: files?.[0]?.data ?? draft.fileData,
      maskBlob: value.maskBlob, maskData: value.maskBlob ? URL.createObjectURL(value.maskBlob) : draft.maskData,
      markupBlob: value.markupBlob, markupData: value.markupBlob ? URL.createObjectURL(value.markupBlob) : draft.markupData };
  } finally { db.close(); }
}

export async function deleteBlobDraft(id: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
