#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

function declared(envText, key) {
  return new RegExp(`^${key}=`, 'm').test(envText);
}

const envExample = read('.env.example');
for (const key of [
  'MODELPORT_API_KEY',
  'DEEPSEEK_API_KEY',
  'WOLF_RESEARCH_LLM_AGENT_ENABLED',
  'WOLF_RESEARCH_LLM_QUERY_REWRITE_ENABLED',
  'WOLF_RESEARCH_QUERY_REWRITE_LLM_TIMEOUT_MS',
  'WOLF_RESEARCH_QUERY_REWRITE_LLM_MAX_RETRIES',
]) {
  if (!declared(envExample, key)) fail(`.env.example must declare ${key}`);
}
for (const line of envExample.split(/\r?\n/u)) {
  if (/^(?:MODELPORT_API_KEY|DEEPSEEK_API_KEY)=/u.test(line) && !/=(?:\s*|<[^>]+>)$/u.test(line)) {
    fail('.env.example must not contain a real provider credential');
  }
}
for (const key of ['OPENAI_API_KEY', 'CODEX_OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MINIMAX_API_KEY']) {
  if (declared(envExample, key)) fail(`.env.example must not declare retired provider key ${key}`);
}

const llm = JSON.parse(read('config/llm.json'));
const profiles = llm.profiles || {};
const expectedProfiles = {
  'local_qwen:qwen3.5-9b-q5km': {
    provider: 'openai', model: 'local_qwen:qwen3.5-9b-q5km',
    baseUrl: 'http://127.0.0.1:38082/v1', credentialEnv: 'MODELPORT_API_KEY',
  },
  'deepseek:deepseek-v4-flash': {
    provider: 'openai', model: 'deepseek:deepseek-v4-flash',
    baseUrl: 'http://127.0.0.1:38082/v1', credentialEnv: 'MODELPORT_API_KEY',
  },
  'deepseek-v4-flash': {
    provider: 'deepseek', model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com', credentialEnv: 'DEEPSEEK_API_KEY',
  },
};
if (llm.schemaVersion !== 1 || llm.defaultProfileId !== 'local_qwen:qwen3.5-9b-q5km') {
  fail('config/llm.json must use schemaVersion 1 and local Qwen as the default');
}
for (const [id, expected] of Object.entries(expectedProfiles)) {
  const profile = profiles[id];
  if (!profile || Object.entries(expected).some(([key, value]) => profile[key] !== value)) {
    fail(`config/llm.json profile is not locked: ${id}`);
    continue;
  }
  if (profile.agent?.enabled !== true || profile.queryRewrite?.enabled !== true || profile.queryRewrite?.timeoutMs !== 15000) {
    fail(`config/llm.json profile runtime settings are incomplete: ${id}`);
  }
}

const modelRegistry = read('src/lib/constants/models.ts');
for (const required of [
  "DEEPSEEK_MODEL_ID = 'deepseek-v4-flash'",
  "DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com'",
  "MODELPORT_DEEPSEEK_MODEL_ID = 'deepseek:deepseek-v4-flash'",
  "LOCAL_QWEN_MODEL_ID = 'local_qwen:qwen3.5-9b-q5km'",
  "LOCAL_OPENAI_BASE_URL = 'http://127.0.0.1:38082/v1'",
  'PI_AGENT_DEFAULT_MODEL: PiAgentModelId = LOCAL_QWEN_MODEL_ID',
]) {
  if (!modelRegistry.includes(required)) fail(`model registry missing locked value: ${required}`);
}

const packageText = read('package.json');
if (!packageText.includes('"@earendil-works/pi-agent-core": "0.82.1"')) {
  fail('PI Agent core must remain pinned to 0.82.1');
}
if (!packageText.includes('"@earendil-works/pi-ai": "0.82.1"')) {
  fail('PI Agent AI package must remain pinned to 0.82.1');
}
if (/@anthropic-ai|claude-agent-sdk/iu.test(packageText)) fail('retired Anthropic Agent SDK remains in package.json');

const deepSeekProvider = read('src/lib/agent/providers/deepseek.ts');
const compatibleProvider = read('src/lib/agent/providers/openai-compatible.ts');
if (!deepSeekProvider.includes('/chat/completions') || !deepSeekProvider.includes('globalThis.fetch')) {
  fail('DeepSeek provider must use the controlled /chat/completions fetch boundary');
}
if (!compatibleProvider.includes("reasoningWireFormat: 'none'")) {
  fail('OpenAI-compatible provider must disable DeepSeek-only reasoning fields');
}

const runtime = read('src/lib/services/cli/pi-agent.ts');
if (!runtime.includes('process.env[llmConfig.credentialEnv]')) {
  fail('PI Agent runtime must read credentials through the locked profile boundary');
}
for (const token of [
  'process.env.OPENAI_API_KEY',
  'process.env.CODEX_OPENAI_API_KEY',
  'process.env.ANTHROPIC_API_KEY',
  'process.env.MINIMAX_API_KEY',
  'process.env.DEEPSEEK_BASE_URL',
]) {
  if (runtime.includes(token)) fail(`PI Agent runtime reads a retired provider setting: ${token}`);
}
for (const relativePath of [
  'src/lib/agent/providers/deepseek.ts',
  'src/lib/agent/providers/openai-compatible.ts',
  'src/lib/services/cli/pi-agent.ts',
  'src/lib/config/llm.ts',
]) {
  if (/D:[\\/]QuantPilot|wolf-dashboard/iu.test(read(relativePath))) {
    fail(`${relativePath} contains a cross-project runtime reference`);
  }
}

if (failures.length > 0) {
  console.error('[ai-provider-boundary] failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('[ai-provider-boundary] ok: locked model profiles and provider boundaries passed');
}
