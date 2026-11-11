/** Local bounded image preparation. Server-side processing is only a fallback. */
export const IMAGE_INPUT_LIMIT = 60 * 1024 * 1024;
export const IMAGE_PIXEL_LIMIT = 25_000_000;
export const REFERENCE_LIMIT = 49_000_000;
export const OVERLAY_LIMIT = 3_900_000;

type Kind = 'image' | 'mask' | 'markup';
type Decoded = { width: number; height: number; close(): void };
export type PreparedLocalImage = { blob: Blob; width: number; height: number; changed: boolean; resized: boolean };
type Codec = {
  decode(blob: Blob): Promise<Decoded>;
  encode(image: Decoded, width: number, height: number, type: string, quality?: number, smooth?: boolean): Promise<Blob>;
  hasTransparency(image: Decoded): boolean;
  inspect?(blob: Blob): Promise<[number, number]>;
};

const browserCodec: Codec = {
  inspect: inspectDimensions,
  decode: blob => createImageBitmap(blob, { imageOrientation: 'from-image' }),
  async encode(image, width, height, type, quality, smooth = true) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建本地图片处理画布。');
    context.imageSmoothingEnabled = smooth;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image as ImageBitmap, 0, 0, width, height);
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
      if (!blob || blob.type !== type) throw new Error('本地图片编码失败。');
      return blob;
    } finally { canvas.width = 0; canvas.height = 0; }
  },
  hasTransparency(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    // Inspect in strips so validation does not allocate another full RGBA image.
    canvas.height = Math.min(image.height, 256);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法检查透明通道。');
    try {
      for (let y = 0; y < image.height; y += canvas.height) {
        const height = Math.min(canvas.height, image.height - y);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image as ImageBitmap, 0, y, image.width, height, 0, 0, image.width, height);
        const pixels = context.getImageData(0, 0, image.width, height).data;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
      }
      return false;
    } finally { canvas.width = 0; canvas.height = 0; }
  },
};

/** Read only bounded headers before the browser allocates a decoded bitmap. */
async function inspectDimensions(blob: Blob): Promise<[number, number]> {
  const data = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());
  const text = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (blob.type === 'image/png' && data.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value) && text(12, 16) === 'IHDR')
    return [view.getUint32(16), view.getUint32(20)];
  if (blob.type === 'image/webp' && data.length >= 30 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    const chunk = text(12, 16);
    if (chunk === 'VP8X') return [1 + data[24] + (data[25] << 8) + (data[26] << 16), 1 + data[27] + (data[28] << 8) + (data[29] << 16)];
    if (chunk === 'VP8L' && data[20] === 0x2f) return [1 + data[21] + ((data[22] & 63) << 8), 1 + (data[22] >> 6) + (data[23] << 2) + ((data[24] & 15) << 10)];
    if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 1 && data[25] === 0x2a)
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  if (blob.type === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    for (let count = 0; count < 4096 && offset + 3 < data.length; count++) {
      if (data[offset++] !== 0xff) break;
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > data.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 7) break;
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  throw new Error('无法读取图片尺寸，或图片头部超过安全限制。');
}

function checkInput(blob: Blob, kind: Kind) {
  if (!blob.size || blob.size > IMAGE_INPUT_LIMIT) throw new Error('单张图片必须小于 60 MiB。');
  if (!(kind === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : ['image/png']).includes(blob.type))
    throw new Error(kind === 'image' ? '参考图仅支持 PNG、JPEG、WebP。' : '蒙版和标注层必须是 PNG。');
}

async function rejectAnimation(blob: Blob) {
  if (blob.type === 'image/webp') {
    const head = new Uint8Array(await blob.slice(0, 21).arrayBuffer());
    if (head.length >= 21 && String.fromCharCode(...head.slice(12, 16)) === 'VP8X' && (head[20] & 2))
      throw new Error('暂不支持动画图片。');
  } else if (blob.type === 'image/png') {
    // APNG declares acTL before the first IDAT. Read only chunk headers and
    // bound their number to avoid scanning untrusted payloads indefinitely.
    let offset = 8;
    for (let chunks = 0; offset + 12 <= blob.size && chunks < 4096; chunks++) {
      const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
      const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
      const type = String.fromCharCode(...header.slice(4));
      if (type === 'acTL') throw new Error('暂不支持动画图片。');
      if (type === 'IDAT' || type === 'IEND') return;
      offset += length + 12;
      if (offset > blob.size) throw new Error('图片格式无效。');
    }
    throw new Error('图片格式无效或包含过多数据块。');
  }
}

/** Injecting a codec also permits deterministic tests without a browser canvas. */
export function createImagePreparation(codec: Codec = browserCodec) {
  async function open(blob: Blob, kind: Kind) {
    checkInput(blob, kind);
    await rejectAnimation(blob);
    if (codec.inspect) {
      const [width, height] = await codec.inspect(blob);
      if (!width || !height || width * height > IMAGE_PIXEL_LIMIT) throw new Error('图片超过 2500 万像素的安全限制。');
    }
    let image: Decoded;
    try { image = await codec.decode(blob); } catch { throw new Error('无法读取图片，请检查文件格式。'); }
    if (!image.width || !image.height || image.width * image.height > IMAGE_PIXEL_LIMIT) {
      image.close();
      throw new Error('图片超过 2500 万像素的安全限制。');
    }
    try {
      if (kind !== 'image' && !codec.hasTransparency(image)) throw new Error('蒙版或标注层必须包含透明像素。');
    } catch (error) { image.close(); throw error; }
    return image;
  }
  async function encode(image: Decoded, source: Blob, width: number, height: number, limit: number, kind: Kind) {
    // Keep all PNG and WebP inputs lossless: in particular, never discard alpha.
    const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    if (type === 'image/jpeg') {
      for (const quality of [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6]) {
        const result = await codec.encode(image, width, height, type, quality);
        if (result.size <= limit) return result;
      }
      return null;
    }
    const result = await codec.encode(image, width, height, type, undefined, kind !== 'mask');
    return result.size <= limit ? result : null;
  }
  async function prepare(imageBlob: Blob, overlayBlob?: Blob, kind: 'mask' | 'markup' = 'mask',
    confirmResize: () => boolean | Promise<boolean> = () => false) {
    const image = await open(imageBlob, 'image');
    let layer: Decoded | undefined;
    try {
      if (overlayBlob) {
        layer = await open(overlayBlob, kind);
        if (image.width !== layer.width || image.height !== layer.height) throw new Error('蒙版或标注层必须与基准图尺寸一致。');
      }
      const initialWidth = image.width, initialHeight = image.height;
      let width = initialWidth, height = initialHeight, resizeApproved = false;
      let base: Blob | null = imageBlob.size <= REFERENCE_LIMIT ? imageBlob : null;
      let overlay: Blob | null = !overlayBlob || overlayBlob.size <= OVERLAY_LIMIT ? overlayBlob ?? null : null;
      for (let attempt = 0; attempt < 17; attempt++) {
        base ??= await encode(image, imageBlob, width, height, REFERENCE_LIMIT, 'image');
        if (layer && overlayBlob) overlay ??= await encode(layer, overlayBlob, width, height, OVERLAY_LIMIT, kind);
        if (base && (!layer || overlay)) {
          const resized = width !== initialWidth || height !== initialHeight;
          if (layer && overlay && overlay !== overlayBlob) {
            const result = await open(overlay, kind);
            result.close();
          }
          return {
            image: { blob: base, width, height, changed: base !== imageBlob, resized },
            overlay: overlay && overlayBlob ? { blob: overlay, width, height, changed: overlay !== overlayBlob, resized } : undefined,
          };
        }
        if (attempt === 16 || Math.min(width, height) <= 1) break;
        if (!resizeApproved) {
          if (!(await confirmResize())) throw new Error('已取消图片缩放。');
          resizeApproved = true;
        }
        width = Math.max(1, Math.floor(width * 0.85));
        height = Math.max(1, Math.floor(height * 0.85));
        base = null;
        overlay = null;
      }
      throw new Error('图片无法压缩至大小限制，请更换素材。');
    } finally { image.close(); layer?.close(); }
  }
  return { prepare };
}

export const prepareLocalImage = createImagePreparation().prepare;
