export function workflowReferencePrice(catalog: unknown, templateId: string): number | null {
  if (!catalog || typeof catalog !== 'object') return null;
  const templates = (catalog as { templates?: unknown }).templates;
  if (!Array.isArray(templates)) return null;
  const matches = templates.filter(
    (item) => item && typeof item === 'object' && item.id === templateId,
  );
  if (matches.length !== 1) return null;
  const price = matches[0].display?.price;
  if (
    !price ||
    price.currency !== 'USD' ||
    price.unit !== '次' ||
    typeof price.amount !== 'number' ||
    !Number.isFinite(price.amount) ||
    price.amount < 0
  )
    return null;
  return price.amount;
}

export function workflowHasImagePricing(catalog: unknown, templateId: string): boolean {
  if (!catalog || typeof catalog !== 'object') return false;
  const templates = (catalog as { templates?: unknown }).templates;
  if (!Array.isArray(templates)) return false;
  const matches = templates.filter((item) => item && typeof item === 'object' && item.id === templateId);
  return matches.length === 1 && matches[0].display?.pricingMode === 'image';
}

export function workflowHasVideoPricing(catalog: unknown, templateId: string): boolean {
  if (!catalog || typeof catalog !== 'object') return false;
  const templates = (catalog as { templates?: unknown }).templates;
  if (!Array.isArray(templates)) return false;
  const matches = templates.filter((item) => item && typeof item === 'object' && item.id === templateId);
  return matches.length === 1 && matches[0].display?.pricingMode === 'video';
}

export function formatWorkflowUsd(amount: number): string {
  return `$${amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} USD`;
}

export function formatImagePriceDetails(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const detail = value as { counts?: Record<string, unknown>; outputCount?: unknown; rule?: Record<string, unknown>; amountUnits?: unknown };
  const counts = detail.counts;
  const rule = detail.rule;
  const values = [counts?.image, counts?.mask, counts?.markup, detail.outputCount, rule?.baseUnits, rule?.imageUnits, rule?.maskUnits, rule?.markupUnits, detail.amountUnits];
  if (values.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return '';
  const money = (value: unknown) => formatWorkflowUsd((value as number) / 1e8);
  return `基础 ${money(rule!.baseUnits)} + 参考图 ${counts!.image} × ${money(rule!.imageUnits)} + 蒙版 ${counts!.mask} × ${money(rule!.maskUnits)} + 标注层 ${counts!.markup} × ${money(rule!.markupUnits)}，整体 × ${detail.outputCount} 张；规则合计 ${money(detail.amountUnits)}（实际扣费以确认报价为准）`;
}

export function formatVideoPriceDetails(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const detail = value as { outputSeconds?: unknown; inputMilliseconds?: unknown; billedInputMilliseconds?: unknown; imageCount?: unknown; billableImages?: unknown; amountUnits?: unknown; rule?: Record<string, unknown> };
  const rule = detail.rule;
  const values = [detail.outputSeconds, detail.inputMilliseconds, detail.billedInputMilliseconds, detail.imageCount, detail.billableImages, detail.amountUnits, rule?.baseUnits, rule?.outputSecondUnits, rule?.inputSecondUnits, rule?.imageUnits];
  if (values.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return '';
  const money = (item: unknown) => formatWorkflowUsd((item as number) / 1e8);
  return `基础 ${money(rule!.baseUnits)} + 输出 ${detail.outputSeconds} 秒 × ${money(rule!.outputSecondUnits)} + 输入视频 ${Number(detail.billedInputMilliseconds) / 1000} 秒 × ${money(rule!.inputSecondUnits)} + 收费图片 ${detail.billableImages}/${detail.imageCount} 张 × ${money(rule!.imageUnits)}；规则合计 ${money(detail.amountUnits)}（实际扣费以确认报价为准）`;
}
