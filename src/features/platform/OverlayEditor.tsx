import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { overlayDimensions } from './overlayDimensions';

/** Paint an overlay against the first reference image; never modifies that image. */
export function OverlayEditor({ image, kind, onSave, onCancel }: {
  image: string;
  kind: 'mask' | 'markup';
  onSave: (data: string) => void;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const previous = useRef<[number, number] | null>(null);
  const [size, setSize] = useState(32);
  const [color, setColor] = useState('#ff3333');
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const base = new Image();
    base.onload = () => {
      if (cancelled || !canvas.current) return;
      const [width, height] = overlayDimensions(base.naturalWidth, base.naturalHeight);
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
  function save() {
    const painted = canvas.current;
    if (!painted) return;
    const context = painted.getContext('2d');
    if (!context || !context.getImageData(0, 0, painted.width, painted.height).data.some((v, i) => i % 4 === 3 && v > 0)) {
      setError('请先在图片上绘制需要修改的位置。');
      return;
    }
    const output = document.createElement('canvas');
    output.width = painted.width;
    output.height = painted.height;
    const target = output.getContext('2d');
    if (!target) { setError('无法创建图片，请重试。'); return; }
    if (kind === 'mask') {
      target.fillStyle = '#fff';
      target.fillRect(0, 0, output.width, output.height);
      target.globalCompositeOperation = 'destination-out';
    }
    target.drawImage(painted, 0, 0);
    const data = output.toDataURL('image/png');
    if (Math.ceil((data.length - data.indexOf(',') - 1) * 3 / 4) > 2 * 1024 * 1024) {
      setError('绘制结果超过 2 MB，请减少标注后重试。');
      return;
    }
    onSave(data);
  }
  return <div className="pfx-paint-backdrop" role="dialog" aria-modal="true" aria-label={kind === 'mask' ? '绘制蒙版' : '绘制标注层'}>
    <div className="pfx-paint-dialog">
      <h2>{kind === 'mask' ? '绘制需要修改的区域' : '在图片上圈画或标注'}</h2>
      <p>{kind === 'mask' ? '涂红的位置是希望 AI 修改的区域，提交时会转换为透明蒙版。' : '标注会作为独立透明图层提交，不会直接画进原图。'}</p>
      <div className="pfx-paint-tools">
        <button type="button" className="pfx-secondary" onClick={() => setErase(!erase)}>{erase ? '橡皮擦（切换画笔）' : '画笔（切换橡皮擦）'}</button>
        <label>大小 <input type="range" min="2" max="160" value={size} onChange={event => setSize(Number(event.target.value))} /> {size}px</label>
        {kind === 'markup' && <label>颜色 <input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>}
        <button type="button" className="pfx-secondary" onClick={() => { const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); }}>清空</button>
      </div>
      <div className="pfx-paint-image"><img src={image} alt="第一张基准图" /><canvas ref={canvas} aria-label="绘制区域" onPointerDown={event => { painting.current = true; event.currentTarget.setPointerCapture(event.pointerId); draw(event, true); }} onPointerMove={event => { if (painting.current) draw(event, false); }} onPointerUp={() => { painting.current = false; previous.current = null; }} onPointerCancel={() => { painting.current = false; previous.current = null; }} /></div>
      {error && <div className="pfx-alert" role="alert">{error}</div>}
      <div className="pfx-paint-tools"><button type="button" className="pfx-secondary" onClick={onCancel}>取消</button><button type="button" className="pfx-primary" disabled={!ready} onClick={save}>使用{kind === 'mask' ? '蒙版' : '标注'}</button></div>
    </div>
  </div>;
}
