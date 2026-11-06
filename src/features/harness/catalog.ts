export const harnesses = [
  {
    id: 'cline',
    name: 'Cline',
    hint: 'IDE · CLI · 桌面',
    docs: 'https://docs.cline.bot/getting-started/config',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '适配新版共享配置（providers.json / models.json）。保存后重启 Cline，在模型选择器中选择 CYAPI Toolbox。',
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    hint: 'IDE · CLI',
    docs: 'https://kilo.ai/docs/getting-started/settings',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '写入全局 kilo.jsonc；项目配置可能覆盖全局设置。保存后新建会话确认默认模型。',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    hint: 'Alibaba',
    docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '写入用户级 settings.json，设置新会话默认模型。Shell 环境、项目配置及启动参数可能覆盖本配置。',
  },
  {
    id: 'kimi',
    name: 'Kimi Code CLI',
    hint: 'Moonshot',
    docs: 'https://moonshotai.github.io/kimi-cli/en/configuration/providers.html',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '写入 config.toml 的 CYAPI Toolbox 提供商与模型，设置新会话默认模型。',
  },
  {
    id: 'continue',
    name: 'Continue',
    hint: 'IDE · CLI',
    docs: 'https://docs.continue.dev/customize/model-providers/top-level/openai',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '在本地 config.yaml 中添加 CYAPI 模型（chat / edit / apply）。请在 Continue 中选择本地配置及该模型。',
  },
  {
    id: 'roo',
    name: 'Roo Code',
    hint: 'VS Code',
    docs: 'https://docs.roocode.com/features/settings-management',
    protocols: ['openai-completions'],
    note: '生成官方格式的配置导入文件。保存后在 Roo Code 设置 → Import 中选择下方文件；导入会合并已有配置。恢复仅恢复导入文件，已导入的设置需在 Roo Code 中调整。',
  },
  {
    id: 'aider',
    name: 'Aider',
    hint: '终端编程',
    docs: 'https://aider.chat/docs/llms/openai-compat.html',
    protocols: ['openai-completions'],
    note: '写入用户级 .aider.conf.yml，自动添加 openai/ 模型前缀。项目配置和环境变量可能覆盖本配置。',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    hint: 'IDE · 引导配置',
    docs: 'https://cursor.com/docs/settings/api-keys',
    protocols: [],
    note: '在 Cursor Settings → Models 中填写对应服务商 API Key 并保存。自带 Key 的可用模型以 Cursor 当前界面为准，Tab 补全使用内置模型。自定义网关需要当前版本提供 Base URL 覆盖入口。',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    hint: 'Google',
    docs: 'https://geminicli.com/docs/get-started/authentication/',
    protocols: ['gemini'],
    note: '使用原生 Gemini API，写入 ~/.gemini/settings.json 与 .env。地址填写 API 根地址；服务需支持 Gemini generateContent 协议。Google 登录或 Vertex AI 请在 Gemini 内通过 /auth 配置。',
  },
  {
    id: 'grok',
    name: 'Grok Build',
    hint: 'xAI',
    docs: 'https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    note: '写入 Grok Build 的 config.toml 自定义模型并设为默认。保存后运行 grok models 或 /model 确认；支持 GROK_HOME。',
  },
] as const;

export type HarnessTool = (typeof harnesses)[number]['id'];
export type ModelProtocol =
  'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'gemini';
export const protocolLabels: Record<ModelProtocol, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  gemini: 'Gemini 原生 API',
};
export function isHarnessTool(value: string): value is HarnessTool {
  return harnesses.some((item) => item.id === value);
}
