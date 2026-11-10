import { useState, type ReactNode } from 'react';
import './image-viewport.css';

/** Reusable scrollable image preview. Children may overlay the image. */
export function ImageViewport({ image, alt, children }: { image: string; alt: string; children?: ReactNode }) {
  const [zoom, setZoom] = useState(100);
  return <div className="image-viewport-container">
    <div className="image-viewport-tools">
      <button type="button" aria-label="缩小图片" disabled={zoom <= 100} onClick={() => setZoom(Math.max(100, zoom - 25))}>−</button>
      <span aria-live="polite">{zoom}%</span>
      <button type="button" aria-label="放大图片" disabled={zoom >= 400} onClick={() => setZoom(Math.min(400, zoom + 25))}>+</button>
      <button type="button" onClick={() => setZoom(100)}>适合宽度</button>
    </div>
    <div className="image-viewport-scroll"><div className="image-viewport-image" style={{ width: `${zoom}%` }}>
      <img src={image} alt={alt} />
      {children}
    </div></div>
  </div>;
}
