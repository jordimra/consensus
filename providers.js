// Provider adapters. Each exposes:
//   listModels(apiKey)  -> string[]
//   chat({ apiKey, model, system, messages, maxTokens, signal, onWait }) -> { text, usage: { input, output } }

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });

const MAX_RETRIES = 4;
const MAX_WAIT_MS = 60_000; // longer waits pause the debate instead of blocking
const RETRYABLE = new Set([429, 503, 529]);
const QUOTA_PATTERN = /insufficient_quota|credit balance|out of credits|exceeded your current quota|billing/i;

// Wait suggested by the provider: Retry-After header (seconds or date) or Gemini's RetryInfo detail.
function suggestedWaitMs(res, body) {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const retryInfo = body?.error?.details?.find(d => d['@type']?.endsWith('RetryInfo'));
  return retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) * 1000 : null;
}

// Error codes: unauthorized | quota_exhausted | rate_limited | provider_error
function classify(status, body, waitMs) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (RETRYABLE.has(status) && waitMs !== null) return 'rate_limited'; // provider says "retry later": temporary
  if (QUOTA_PATTERN.test(JSON.stringify(body?.error ?? body ?? ''))) return 'quota_exhausted';
  return RETRYABLE.has(status) ? 'rate_limited' : 'provider_error';
}

async function http(url, options, onWait) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;

    const waitMs = suggestedWaitMs(res, body);
    const err = Object.assign(new Error(body?.error?.message ?? body?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      code: classify(res.status, body, waitMs),
    });
    const delay = waitMs ?? 1000 * 2 ** attempt; // exponential backoff when no hint
    if (err.code !== 'rate_limited' || attempt > MAX_RETRIES || delay > MAX_WAIT_MS) throw err;

    onWait?.({ seconds: Math.ceil(delay / 1000), attempt, max: MAX_RETRIES, status: res.status });
    await sleep(delay, options.signal);
  }
}

// ---- OpenAI-compatible providers (same API, different base URL) ----
const OPENAI_COMPATIBLE = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', tokenParam: 'max_completion_tokens' },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', tokenParam: 'max_tokens' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', tokenParam: 'max_tokens' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', tokenParam: 'max_tokens' },
  xai: { label: 'xAI', baseUrl: 'https://api.x.ai/v1', tokenParam: 'max_tokens' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', tokenParam: 'max_tokens' },
  together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', tokenParam: 'max_tokens' },
};

function openAiCompatible({ label, baseUrl, tokenParam }) {
  const headers = apiKey => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` });
  return {
    label,
    async listModels(apiKey) {
      const body = await http(`${baseUrl}/models`, { headers: headers(apiKey) });
      const list = Array.isArray(body) ? body : body.data;
      return list.map(m => m.id).sort();
    },
    async chat({ apiKey, model, system, messages, maxTokens, signal, onWait }) {
      const body = await http(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(apiKey),
        signal,
        body: JSON.stringify({
          model,
          [tokenParam]: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      }, onWait);
      return {
        text: body.choices?.[0]?.message?.content ?? '',
        usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

// ---- Anthropic ----
const anthropic = {
  label: 'Anthropic',
  async listModels(apiKey) {
    const body = await http('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    return body.data.map(m => m.id);
  },
  async chat({ apiKey, model, system, messages, maxTokens, signal, onWait }) {
    const body = await http('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, system, messages, max_tokens: maxTokens }),
    }, onWait);
    return {
      text: body.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
    };
  },
};

// ---- Google Gemini ----
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const gemini = {
  label: 'Google Gemini',
  async listModels(apiKey) {
    const body = await http(`${GEMINI_URL}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey } });
    return body.models
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .sort();
  },
  async chat({ apiKey, model, system, messages, maxTokens, signal, onWait }) {
    const body = await http(`${GEMINI_URL}/models/${model}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }, onWait);
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts.map(p => p.text ?? '').join(''),
      usage: {
        input: body.usageMetadata?.promptTokenCount ?? 0,
        output: (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  },
};

export const PROVIDERS = {
  anthropic,
  gemini,
  ...Object.fromEntries(Object.entries(OPENAI_COMPATIBLE).map(([id, cfg]) => [id, openAiCompatible(cfg)])),
};
