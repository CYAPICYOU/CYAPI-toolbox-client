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

export function formatWorkflowUsd(amount: number): string {
  return `$${amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} USD`;
}
