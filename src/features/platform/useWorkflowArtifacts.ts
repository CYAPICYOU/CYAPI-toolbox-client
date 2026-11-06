import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { nativeAvailable } from '../../lib/api/native';
import { downloadWorkflowArtifact, type WorkflowTask, type WorkflowTaskOutput } from './api';
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

export function useWorkflowArtifacts(activeKey: string, tasks: WorkflowTask[], enabled: boolean) {
  const [artifacts, setArtifacts] = useState<Record<string, string>>({});
  const [artifactErrors, setArtifactErrors] = useState<Record<string, string>>({});
  const [imageHashes, setImageHashes] = useState<Record<string, string>>({});
  const [saveNotice, setSaveNotice] = useState('');
  const [zipTaskId, setZipTaskId] = useState('');
  const pending = useRef(new Set<string>());
  const urls = useRef<string[]>([]);
  const generation = useRef(0);
  const zipBusy = useRef(false);

  useEffect(
    () => () => {
      generation.current++;
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
      pending.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !activeKey) return;
    const request = generation.current;
    for (const task of tasks) {
      if (task.status !== 'succeeded') continue;
      for (const output of task.outputs) {
        const id = output.download;
        if (artifacts[id] || artifactErrors[id] || pending.current.has(id)) continue;
        pending.current.add(id);
        void downloadWorkflowArtifact(activeKey, id)
          .then((url) => {
            if (request !== generation.current) {
              URL.revokeObjectURL(url);
              return;
            }
            urls.current.push(url);
            setArtifacts((current) => ({ ...current, [id]: url }));
          })
          .catch((cause) => {
            if (request === generation.current)
              setArtifactErrors((current) => ({ ...current, [id]: errorText(cause) }));
          })
          .finally(() => {
            if (request === generation.current) pending.current.delete(id);
          });
      }
    }
  }, [tasks, enabled, activeKey, artifacts, artifactErrors]);

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
        setSaveNotice(`打包失败，未生成 ZIP：${errorText(cause)}。请重试或单个下载。`);
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
    imageHashes,
    saveNotice,
    zipTaskId,
    saveOutput,
    saveTaskZip,
    retryArtifact,
  };
}
