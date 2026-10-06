import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers.js';
import { runDebate } from './debate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

app.get('/api/providers', (req, res) => {
  res.json(Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })));
});

app.get('/api/locales/:lang', async (req, res) => {
  const lang = /^[a-z]{2}$/.test(req.params.lang) ? req.params.lang : 'en';
  for (const candidate of [lang, 'en']) {
    try {
      const file = await readFile(path.join(__dirname, 'locales', `${candidate}.json`), 'utf8');
      return res.type('json').send(file);
    } catch {
      /* try fallback */
    }
  }
  res.status(404).json({});
});

app.post('/api/models', async (req, res) => {
  const { provider, apiKey } = req.body ?? {};
  if (!PROVIDERS[provider] || !apiKey) return res.status(400).json({ error: 'invalid_request' });
  try {
    res.json({ models: await PROVIDERS[provider].listModels(apiKey) });
  } catch (err) {
    const unauthorized = err.status === 401 || err.status === 403;
    res.status(unauthorized ? 401 : 502).json({ error: unauthorized ? 'unauthorized' : 'provider_error', message: err.message });
  }
});

app.post('/api/debate', async (req, res) => {
  const { question, participants, limits = {}, state } = req.body ?? {};
  const valid =
    typeof question === 'string' && question.trim() &&
    Array.isArray(participants) && participants.length === 2 &&
    participants.every(p => PROVIDERS[p?.provider] && p.apiKey && p.model);
  if (!valid) return res.status(400).json({ error: 'invalid_request' });

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const config = {
    question: question.trim(),
    participants: participants.map(p => ({
      provider: p.provider,
      apiKey: p.apiKey,
      model: p.model,
      priceIn: clamp(p.priceIn, 0, 1000, 0),
      priceOut: clamp(p.priceOut, 0, 1000, 0),
    })),
    limits: {
      maxRounds: clamp(limits.maxRounds, 1, 20, 6),
      maxTokensPerTurn: clamp(limits.maxTokensPerTurn, 100, 4000, 1024),
      maxTotalTokens: clamp(limits.maxTotalTokens, 1000, 500000, 20000),
      maxBudget: clamp(limits.maxBudget, 0, 1000, 0),
    },
    signal: controller.signal,
    state,
    onEvent: send,
  };

  try {
    for await (const event of runDebate(config)) send(event);
  } catch (err) {
    send({ type: 'error', code: 'unexpected', message: err.message });
  }
  res.end();
});

// Bound to localhost only: API keys travel from the browser to this local server.
app.listen(PORT, '127.0.0.1', () => console.log(`consensus running at http://localhost:${PORT}`));
