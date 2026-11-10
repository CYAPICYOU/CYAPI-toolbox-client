/** Match the image engine's Pillow thumbnail aspect-ratio rounding. */
export function overlayDimensions(width: number, height: number): [number, number] {
  if (width <= 2048 && height <= 2048) return [width, height];
  const aspect = width / height;
  const nearest = (number: number, error: (value: number) => number) => {
    const lower = Math.floor(number);
    const upper = Math.ceil(number);
    return Math.max(error(lower) <= error(upper) ? lower : upper, 1);
  };
  return aspect <= 1
    ? [nearest(2048 * aspect, n => Math.abs(aspect - n / 2048)), 2048]
    : [2048, nearest(2048 / aspect, n => n === 0 ? 0 : Math.abs(aspect - 2048 / n))];
}
