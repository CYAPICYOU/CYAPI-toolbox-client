import type { McpView } from './api/native';

export type McpWorkspace = McpView['workspace'];

/**
 * The toolbox workspaces, in the order the UI lists them.
 *
 * Codex, Claude Code and OpenCode are managed directly; Qwen Code is exposed
 * as a harness for model settings but also has its own MCP and log surface.
 */
export const mcpWorkspaces = ['codex', 'claude', 'opencode', 'qwen'] as const;

export const mcpWorkspaceNames: Record<McpWorkspace, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
};

/**
 * Claude Code and Qwen Code keep every server in one flat `mcpServers` map
 * with no enable/disable flag, so the UI must not offer a toggle for them.
 * Adding another such agent means editing this list only.
 *
 * Mirrors `flat_mcp_layout` in `src-tauri/src/mcp.rs`.
 */
export const flatMcpWorkspaces: readonly McpWorkspace[] = ['claude', 'qwen'];

export function isFlatMcpWorkspace(workspace: McpWorkspace): boolean {
  return flatMcpWorkspaces.includes(workspace);
}

/**
 * Qwen reads streamable HTTP from `httpUrl` and reserves `url` for the legacy
 * SSE transport, so a remote server must be described differently there.
 *
 * Mirrors `http_url_key` in `src-tauri/src/mcp.rs`.
 */
export const httpUrlWorkspaces: readonly McpWorkspace[] = ['qwen'];

export function mcpUrlFieldLabel(workspace: McpWorkspace): string {
  return httpUrlWorkspaces.includes(workspace) ? 'httpUrl（HTTP）' : 'URL';
}
