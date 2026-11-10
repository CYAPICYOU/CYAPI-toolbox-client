import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Modal } from './Primitives';
import { ImageViewport } from './ImageViewport';
import './image-annotation.css';

/** Shared image editor. Mask exports selected pixels transparent; markup exports
 * the painted strokes on transparency. The source image is never modified. */
export function ImageAnnotationEditor({ image, kind, onSave, onCancel, outputSize, maxBytes }: {
  image: string;
  kind: 'mask' | 'markup';
  onSave: (data: string) => void;
  onCancel: () => void;
  outputSize?: (width: number, height: number) => [number, number];
  maxBytes?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sizeResolver = useRef(outputSize);
  sizeResolver.current = outputSize;
  const painting = useRef(false);
  const previous = useRef<[number, number] | null>(null);
  const [size, setSize] = useState(32);
  const [color, setColor] = useState('#ff3333');
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setPreview('');
    setError('');
    const base = new Image();
    base.onload = () => {
      if (cancelled || !canvas.current) return;
      const [width, height] = sizeResolver.current?.(base.naturalWidth, base.naturalHeight) ?? [base.naturalWidth, base.naturalHeight];
      canvas.current.width = width;
      canvas.current.height = height;
      setReady(true);
    };
    base.onerror = () => !cancelled && setError('无法读取基准图。');
    base.src = image;
    return () => { cancelled = true; };
  }, [image]);
  function draw(event: PointerEvent<HTMLCanvasElement>, start: boolean) {
    const surface = canvas.current;
    if (!surface || !ready) return;
    const rect = surface.getBoundingClientRect();
    const point: [number, number] = [(event.clientX - rect.left) * surface.width / rect.width, (event.clientY - rect.top) * surface.height / rect.height];
    const context = surface.getContext('2d');
    if (!context) return;
    context.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    context.strokeStyle = kind === 'mask' ? '#ff3333' : color;
    context.lineWidth = size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    const from = start ? point : previous.current ?? point;
    context.moveTo(from[0], from[1]);
    context.lineTo(point[0] + (start ? 0.01 : 0), point[1]);
    context.stroke();
    context.globalCompositeOperation = 'source-over';
    previous.current = point;
  }
  function exportPng(): string | null {
    const painted = canvas.current;
    if (!painted) return null;
    const context = painted.getContext('2d');
    if (!context || !context.getImageData(0, 0, painted.width, painted.height).data.some((v, i) => i % 4 === 3 && v > 0)) {
      setError('请先在图片上绘制需要修改的位置。');
      return null;
    }
    const output = document.createElement('canvas');
    output.width = painted.width;
    output.height = painted.height;
    const target = output.getContext('2d');
    if (!target) { setError('无法创建图片，请重试。'); return null; }
    if (kind === 'mask') {
      target.fillStyle = '#fff';
      target.fillRect(0, 0, output.width, output.height);
      target.globalCompositeOperation = 'destination-out';
    }
    target.drawImage(painted, 0, 0);
    const data = output.toDataURL('image/png');
    if (maxBytes && Math.ceil((data.length - data.indexOf(',') - 1) * 3 / 4) > maxBytes) {
      setError(`绘制结果超过 ${Math.ceil(maxBytes / 1024)} KB，请减少标注后重试。`);
      return null;
    }
    setError('');
    return data;
  }
  return <Modal title={kind === 'mask' ? '绘制蒙版' : '绘制标注层'} onClose={onCancel} wide className="image-annotation-dialog">
      <p>{kind === 'mask' ? '涂红的位置是希望 AI 修改的区域，提交时会转换为透明蒙版。' : '标注会作为独立透明图层提交，不会直接画进原图。'}</p>
      <div className="image-annotation-tools">
        <button type="button" disabled={!!preview} onClick={() => setErase(!erase)}>{erase ? '橡皮擦（切换画笔）' : '画笔（切换橡皮擦）'}</button>
        <label>大小 <input type="range" min="2" max="160" value={size} onChange={event => setSize(Number(event.target.value))} /> {size}px</label>
        {kind === 'markup' && <label>颜色 <input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>}
        <button type="button" disabled={!!preview} onClick={() => { const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); }}>清空</button>
      </div>
      <ImageViewport image={preview || image} alt={preview ? '透明 PNG 预览' : '基准图'}>
        <canvas ref={canvas} aria-label="绘制区域" style={{ visibility: preview ? 'hidden' : 'visible' }} onPointerDown={event => { painting.current = true; event.currentTarget.setPointerCapture(event.pointerId); draw(event, true); }} onPointerMove={event => { if (painting.current) draw(event, false); }} onPointerUp={() => { painting.current = false; previous.current = null; }} onPointerCancel={() => { painting.current = false; previous.current = null; }} />
      </ImageViewport>
      <p>画面可滚动；预览中的棋盘格表示透明区域。{kind === 'mask' ? '蒙版透明区域表示选中的区域。' : ''}</p>
      {error && <div className="image-annotation-error" role="alert">{error}</div>}
      <div className="image-annotation-tools"><button type="button" onClick={onCancel}>取消</button><button type="button" disabled={!ready} onClick={() => { if (preview) setPreview(''); else { const data = exportPng(); if (data) setPreview(data); } }}>{preview ? '返回绘制' : '预览透明 PNG'}</button><button type="button" disabled={!ready} onClick={() => { const data = exportPng(); if (data) onSave(data); }}>使用{kind === 'mask' ? '蒙版' : '标注'}</button></div>
  </Modal>;
}
