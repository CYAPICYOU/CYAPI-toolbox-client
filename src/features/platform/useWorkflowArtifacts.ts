import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from '../../lib/api/native';
import {
  downloadWorkflowArtifact,
  downloadWorkflowUpload,
  type WorkflowTask,
  type WorkflowTaskOutput,
} from './api';
import { imagePixelHash, saveArtifact, taskArtifactsZip } from './artifactDisplay';
import { errorText } from './taskState';

const nativeSave = (filename: string, base64: string) =>
  invoke<boolean>('save_workflow_artifact', { filename, base64 });
const saveMessage = (saved: boolean) =>
  nativeAvailable
    ? saved
      ? '已保存产物。'
      : '已取消保存。'
    : '已发起浏览器下载，请查看浏览器下载列表。';

/** A queued artifact fetch; `id` deduplicates it while queued or in flight. */
interface DownloadJob {
  id: string;
  load: () => Promise<string>;
  commit: (url: string) => void;
  fail: (message: string) => void;
}

// Each artifact is several megabytes. Loading every successful task at once
// saturates one line, and transfers that slow to a crawl get cut off mid-body.
const MAX_PARALLEL_DOWNLOADS = 2;

export function useWorkflowArtifacts(activeKey: string, tasks: WorkflowTask[], enabled: boolean) {
  const [artifacts, setArtifacts] = useState<Record<string, string>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, string>>({});
  const [referenceErrors, setReferenceErrors] = useState<Record<string, string>>({});
  const [imageHashes, setImageHashes] = useState<Record<string, string>>({});
  const [saveNotice, setSaveNotice] = useState('');
  const [zipTaskId, setZipTaskId] = useState('');
  const pending = useRef(new Set<string>());
  const urls = useRef<string[]>([]);
  const generation = useRef(0);
  const zipBusy = useRef(false);
  const queue = useRef<DownloadJob[]>([]);
  const activeDownloads = useRef(0);

  useEffect(
    () => () => {
      generation.current++;
      queue.current = [];
      activeDownloads.current = 0;
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
      pending.current.clear();
    },
    [],
  );

  function pumpDownloads() {
    const request = generation.current;
    while (activeDownloads.current < MAX_PARALLEL_DOWNLOADS && queue.current.length) {
      const job = queue.current.shift()!;
      activeDownloads.current += 1;
      void job
        .load()
        .then((url) => {
          if (request !== generation.current) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.current.push(url);
          job.commit(url);
        })
        .catch((cause) => {
          if (request === generation.current) job.fail(errorText(cause));
        })
        .finally(() => {
          // An unmounted generation abandons its slot; the cleanup reset it.
          if (request !== generation.current) return;
          pending.current.delete(job.id);
          activeDownloads.current -= 1;
          pumpDownloads();
        });
    }
  }

  function enqueueDownload(job: DownloadJob) {
    if (pending.current.has(job.id)) return;
    pending.current.add(job.id);
    queue.current.push(job);
    pumpDownloads();
  }

  useEffect(() => {
    if (!enabled || !activeKey) return;
    for (const task of tasks) {
      if (task.status !== 'succeeded') continue;
      for (const output of task.outputs) {
        const id = output.download;
        if (artifacts[id] || artifactErrors[id]) continue;
        enqueueDownload({
          id,
          load: () => downloadWorkflowArtifact(activeKey, id),
          commit: (url) => setArtifacts((current) => ({ ...current, [id]: url })),
          fail: (message) => setArtifactErrors((current) => ({ ...current, [id]: message })),
        });
      }
    }
  }, [tasks, enabled, activeKey, artifacts, artifactErrors]);

  // Reference images belong to the finished task's input, not its outputs, so
  // they are loaded from the Key-scoped upload route the same way.
  useEffect(() => {
    if (!enabled || !activeKey) return;
    for (const task of tasks) {
      if (task.status !== 'succeeded') continue;
      for (const id of task.references ?? []) {
        if (references[id] || referenceErrors[id]) continue;
        enqueueDownload({
          id,
          load: () => downloadWorkflowUpload(activeKey, id),
          commit: (url) => setReferences((current) => ({ ...current, [id]: url })),
          fail: (message) => setReferenceErrors((current) => ({ ...current, [id]: message })),
        });
      }
    }
  }, [tasks, enabled, activeKey, references, referenceErrors]);

  useEffect(() => {
    let cancelled = false;
    for (const task of tasks) {
      if (
        (task.source !== 'editor' && task.mode !== 'worker') ||
        task.outputs.filter((output) => output.kind === 'image').length < 2
      )
        continue;
      for (const output of task.outputs) {
        const url = artifacts[output.download];
        if (output.kind !== 'image' || !url || imageHashes[output.download]) continue;
        void imagePixelHash(url)
          .then((hash) => {
            if (!cancelled) setImageHashes((current) => ({ ...current, [output.download]: hash }));
          })
          .catch(() => {});
      }
    }
    return () => {
      cancelled = true;
    };
  }, [tasks, artifacts, imageHashes]);

  async function saveOutput(output: WorkflowTaskOutput) {
    const request = generation.current;
    setSaveNotice('');
    try {
      const saved = await saveArtifact(
        artifacts[output.download],
        output.id,
        nativeAvailable,
        nativeSave,
      );
      if (request === generation.current) setSaveNotice(saveMessage(saved));
    } catch (cause) {
      if (request === generation.current) setSaveNotice(`保存失败：${errorText(cause)}`);
    }
  }

  async function saveTaskZip(task: WorkflowTask) {
    if (zipBusy.current) return;
    zipBusy.current = true;
    const request = generation.current;
    setZipTaskId(task.id);
    setSaveNotice('');
    let zipUrl = '';
    try {
      const archive = await taskArtifactsZip(task.outputs, async (output) => {
        if (request !== generation.current) throw new Error('已取消打包');
        const existing = artifacts[output.download];
        const url = existing || (await downloadWorkflowArtifact(activeKey, output.download));
        try {
          if (request !== generation.current) throw new Error('已取消打包');
          const response = await fetch(url);
          if (!response.ok) throw new Error('无法读取产物');
          return await response.blob();
        } finally {
          if (!existing) URL.revokeObjectURL(url);
        }
      });
      if (request !== generation.current) return;
      zipUrl = URL.createObjectURL(archive);
      const saved = await saveArtifact(
        zipUrl,
        `workflow-${task.id}.zip`,
        nativeAvailable,
        nativeSave,
      );
      if (request === generation.current) setSaveNotice(saveMessage(saved));
    } catch (cause) {
      if (request === generation.current)
        setSaveNotice(
          `${zipUrl ? '保存 ZIP 失败' : '打包失败，未生成 ZIP'}：${errorText(cause)}。请重试或单个下载。`,
        );
    } finally {
      if (zipUrl) URL.revokeObjectURL(zipUrl);
      zipBusy.current = false;
      if (request === generation.current) setZipTaskId('');
    }
  }

  function retryArtifact(id: string) {
    setArtifactErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  return {
    artifacts,
    artifactErrors,
    references,
    referenceErrors,
    imageHashes,
    saveNotice,
    zipTaskId,
    saveOutput,
    saveTaskZip,
    retryArtifact,
  };
}
