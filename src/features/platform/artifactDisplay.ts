export interface DisplayArtifact {
  id: string;
  kind: string;
  download: string;
  storageType?: string;
  role?: 'preview' | 'file' | 'temporary';
}

// Group only pixel-identical images from the same execution. Every original
// remains available as a separate download; unknown comparisons stay separate.
export function groupIdenticalImages<T extends DisplayArtifact>(outputs: T[], hashes: Record<string, string>): T[][] {
  const groups: T[][] = [];
  for (const output of [...outputs].sort((a, b) => Number(b.role === 'file') - Number(a.role === 'file'))) {
    const hash = output.kind === 'image' ? hashes[output.download] : undefined;
    const group = output.role === 'preview' && hash && groups.find(items => items.length === 1 && items[0].role === 'file' && items[0].kind === 'image' && hashes[items[0].download] === hash);
    if (group) group.push(output); else groups.push([output]);
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
    return `${image.width}x${image.height}:` + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  } finally { image.close(); }
}

export async function saveArtifact(url: string, filename: string, native: boolean, invokeSave: (filename: string, base64: string) => Promise<boolean>): Promise<boolean> {
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
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return invokeSave(filename, btoa(binary));
}
