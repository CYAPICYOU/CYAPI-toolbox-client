export type OpenAiProtocol = 'openai-completions' | 'openai-responses';
export type ApiProtocol = OpenAiProtocol | 'anthropic-messages';

const endpointSuffix: Record<ApiProtocol, string> = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
};

/** Keep provider configuration at the API root when a full endpoint was pasted. */
export function normalizeOpenAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/(?:chat\/completions|responses)$/, '');
}

export function openAiEndpoint(value: string, protocol: OpenAiProtocol): string {
  return `${normalizeOpenAiBaseUrl(value)}${endpointSuffix[protocol]}`;
}

export function apiEndpoint(value: string, protocol: ApiProtocol): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const base = trimmed.replace(/\/(?:chat\/completions|responses|messages)$/, '');
  return `${base}${endpointSuffix[protocol]}`;
}
