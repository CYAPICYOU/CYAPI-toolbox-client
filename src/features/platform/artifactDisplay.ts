export interface DisplayArtifact {
  id: string;
  kind: string;
  download: string;
  storageType?: string;
  role?: 'preview' | 'file' | 'temporary';
  sourceNode?: { id: string; type?: string; title?: string };
}

export function artifactSourceLabel(output: DisplayArtifact): string {
  const source = output.sourceNode;
  if (!source?.id) return '来源节点：未知（历史记录未保存）';
  const name = source.title || source.type;
  const type =
    source.title && source.type && source.title !== source.type ? ` · ${source.type}` : '';
  return `来源节点：${name || '名称未知'}${type}（ID ${source.id}）`;
}

// Group only pixel-identical images from the same execution. Every original
// remains available as a separate download; unknown comparisons stay separate.
export function groupIdenticalImages<T extends DisplayArtifact>(
  outputs: T[],
  hashes: Record<string, string>,
): T[][] {
  const groups: T[][] = [];
  for (const output of [...outputs].sort(
    (a, b) => Number(b.role === 'file') - Number(a.role === 'file'),
  )) {
    const hash = output.kind === 'image' ? hashes[output.download] : undefined;
    const group =
      output.role === 'preview' &&
      hash &&
      groups.find(
        (items) =>
          items.length === 1 &&
          items[0].role === 'file' &&
          items[0].kind === 'image' &&
          hashes[items[0].download] === hash,
      );
    if (group) group.push(output);
    else groups.push([output]);
  }
  return groups;
}

export async function imagePixelHash(url: string): Promise<string> {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  try {
    if (image.width * image.height > 25_000_000) throw new Error('图片过大，无法比较');
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法比较图片');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const hash = await crypto.subtle.digest('SHA-256', data);
    return (
      `${image.width}x${image.height}:` +
      Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
    );
  } finally {
    image.close();
  }
}

export async function saveArtifact(
  url: string,
  filename: string,
  native: boolean,
  invokeSave: (filename: string, base64: string) => Promise<boolean>,
): Promise<boolean> {
  if (!native) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    return false;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取产物');
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return invokeSave(filename, btoa(binary));
}

// Keep the archive below the existing native save command's 45 MiB base64 limit.
const MAX_ZIP_INPUT_BYTES = 30 * 1024 * 1024;

export async function taskArtifactsZip(
  outputs: DisplayArtifact[],
  load: (output: DisplayArtifact) => Promise<Blob>,
): Promise<Blob> {
  if (!outputs.length) throw new Error('任务没有可下载的文件');
  if (outputs.length > 100) throw new Error('文件数量超过打包上限，请单个下载');
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const [index, output] of outputs.entries()) {
    const blob = await load(output);
    total += blob.size;
    if (total > MAX_ZIP_INPUT_BYTES) throw new Error('文件总大小超过 30 MB，请单个下载');
    const name =
      output.id
        .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 160) || 'file';
    files[`${String(index + 1).padStart(3, '0')}-${name}`] = new Uint8Array(
      await blob.arrayBuffer(),
    );
  }
  return new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' });
}
import { zipSync } from 'fflate';
