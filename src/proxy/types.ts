export interface AgentConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  configModel?: string;
}

export interface RateLimitConfig {
  maxRequestsPerSecond: number;
}

export interface ConcurrencyConfig {
  maxConcurrentRequests: number;
}

export interface LoggingConfig {
  enabled: boolean;
  directory: string;
  maxFileSizeMB: number;
}

export interface TlsConfig {
  enabled: boolean;
  certPath: string;
  keyPath: string;
}

/** Full request record stored for replay. */
export interface ReplayEntry {
  id: string;
  ts: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  model: string;
  provider: string;
}

export interface FallbackProvider {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  modelMap?: Record<string, string>;
}

export interface ProxyConfig {
  port: number;
  targetBaseUrl: string;
  apiKey: string;
  apiKeys: Record<string, string>;
  defaultModel: string;
  modelMap: Record<string, string>;
  customHeaders: Record<string, string>;
  fallbackProviders: FallbackProvider[];
  kimiConfig: AgentConfig;
  qwenConfig: AgentConfig;
  codexConfig: AgentConfig;
  rateLimit?: RateLimitConfig;
  concurrency?: ConcurrencyConfig;
  logging?: LoggingConfig;
  tls?: TlsConfig;
  upstreamTimeoutMs?: number;
}

// ---- Anthropic types ----

export type AnthropicRole = 'user' | 'assistant';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
}

// ---- OpenAI types ----

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAITool[];
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}