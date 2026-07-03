import type { AgentId } from '../core/types';

/**
 * Static metadata about each agent CLI KAI can drive: how to install it,
 * how to sign in with a personal account (Direct route), and which environment
 * variable carries the API key (used for the Proxy route).
 */
export interface AgentProviderInfo {
  id: AgentId;
  displayName: string;
  /** Config key under the `kai.` namespace that holds the launch command. */
  commandSetting: string;
  defaultCommand: string;
  /** Env var injected into the agent (and proxy) process when a key is stored. */
  envVar: string;
  /** Guided global-install command shown in a terminal for the user to run. */
  installCommand: string;
  /** Native CLI sign-in command for the Direct route (personal account). */
  signInCommand: string;
  /** Where to obtain an API key. */
  keyDocsUrl: string;
  /** One-line explanation of the auth options for this agent. */
  authSummary: string;
}

export const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'qwen', 'gemini'];

export const AGENT_PROVIDERS: Record<AgentId, AgentProviderInfo> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    commandSetting: 'claudeCommand',
    defaultCommand: 'claude',
    envVar: 'ANTHROPIC_API_KEY',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    signInCommand: 'claude',
    keyDocsUrl: 'https://console.anthropic.com/settings/keys',
    authSummary:
      'Direct: sign in with your Anthropic account (Claude Pro/Max/Team). Proxy: set an Anthropic API key.',
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    commandSetting: 'codexCommand',
    defaultCommand: 'codex',
    envVar: 'OPENAI_API_KEY',
    installCommand: 'npm install -g @openai/codex',
    signInCommand: 'codex login',
    keyDocsUrl: 'https://platform.openai.com/api-keys',
    authSummary:
      'Direct: sign in with your ChatGPT account. Proxy: set an OpenAI API key.',
  },
  qwen: {
    id: 'qwen',
    displayName: 'Qwen Code',
    commandSetting: 'qwenCommand',
    defaultCommand: 'qwen',
    envVar: 'DASHSCOPE_API_KEY',
    installCommand: 'npm install -g @qwen-code/qwen-code',
    signInCommand: 'qwen',
    keyDocsUrl: 'https://dashscope.console.aliyun.com/apiKey',
    authSummary:
      'Direct: sign in via the qwen CLI. Proxy: set a DashScope / OpenAI-compatible API key.',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    commandSetting: 'geminiCommand',
    defaultCommand: 'gemini',
    envVar: 'GEMINI_API_KEY',
    installCommand: 'npm install -g @google/gemini-cli',
    signInCommand: 'gemini',
    keyDocsUrl: 'https://aistudio.google.com/apikey',
    authSummary:
      'Direct: sign in with your Google account. Proxy: set a Gemini API key.',
  },
};
