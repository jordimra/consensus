import { PROVIDERS } from './providers.js';

const MARKER = '(?:POSITION|AGREE|FINAL)';
const MAX_WORDS = 150;

function buildSystemPrompt(question, selfName, otherName) {
  return [
    `You are ${selfName}, in a structured debate with ${otherName}. Together you must reach the best answer to this question:`,
    `"""\n${question}\n"""`,
    'Rules:',
    `- Be concise: at most ${MAX_WORDS} words before the final lines.`,
    '- Critique the other answer with substance. Do not agree just to be polite; agree only if you genuinely do.',
    '- Change your position only for good reasons.',
    '- Reply in the same language as the question.',
    'End EVERY reply with exactly these lines:',
    'POSITION: <your current position, max 2 sentences>',
    'AGREE: yes|no',
    'FINAL: <the agreed answer, only if AGREE is yes>',
  ].join('\n');
}

function buildTurnMessage(turn, otherName, otherBody, ownPosition) {
  if (turn === 0) return 'Give your initial answer to the question.';
  return [
    `${otherName} has responded:`,
    `"""\n${otherBody}\n"""`,
    `Your current position: ${ownPosition || '(none yet)'}`,
    'Reply following the rules.',
  ].join('\n\n');
}

function field(text, tag) {
  const re = new RegExp(`^${tag}:[ \\t]*([\\s\\S]*?)(?=^${MARKER}:|(?![\\s\\S]))`, 'm');
  return text.match(re)?.[1].trim() ?? '';
}

export function parseReply(text) {
  return {
    body: text.split(new RegExp(`^${MARKER}:`, 'm'))[0].trim(),
    position: field(text, 'POSITION'),
    agree: /^yes/i.test(field(text, 'AGREE')),
    final: field(text, 'FINAL'),
  };
}

export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Number(v))) : 0);
  const str = v => (typeof v === 'string' ? v.slice(0, 5000) : '');
  return {
    turn: Math.floor(num(s.turn, 100)),
    positions: [str(s.positions?.[0]), str(s.positions?.[1])],
    totals: { tokens: num(s.totals?.tokens, 1e9), cost: num(s.totals?.cost, 1e6) },
    lastBody: str(s.lastBody),
    lastFinal: str(s.lastFinal),
    agreeStreak: Math.floor(num(s.agreeStreak, 2)),
  };
}

/**
 * Async generator yielding events. `state` snapshots let the client resume later (optionally with other models/accounts):
 *   { type: 'turn', index, name, body, position, agree, usage, totals, state }
 *   { type: 'paused', code, message, state }   provider failure (rate limit, quota, bad key...)
 *   { type: 'done', reason, final, totals }    reason: consensus | max_rounds | max_tokens | max_budget
 * Retry waits are reported through onEvent as { type: 'wait', name, seconds, attempt, max, status }.
 */
export async function* runDebate({ question, participants, limits, signal, state: rawState, onEvent }) {
  const names = participants.map(p => `${PROVIDERS[p.provider].label} (${p.model})`);
  const state = normalizeState(rawState);
  const snapshot = () => JSON.parse(JSON.stringify(state));

  for (let turn = state.turn; turn < limits.maxRounds * 2; turn++) {
    const self = turn % 2;
    const other = 1 - self;
    const p = participants[self];

    let result;
    try {
      result = await PROVIDERS[p.provider].chat({
        apiKey: p.apiKey,
        model: p.model,
        system: buildSystemPrompt(question, names[self], names[other]),
        messages: [{ role: 'user', content: buildTurnMessage(turn, names[other], state.lastBody, state.positions[self]) }],
        maxTokens: limits.maxTokensPerTurn,
        signal,
        onWait: info => onEvent?.({ type: 'wait', name: names[self], ...info }),
      });
    } catch (err) {
      if (signal.aborted) return;
      return yield { type: 'paused', code: err.code ?? 'provider_error', message: `${names[self]}: ${err.message}`, state: snapshot() };
    }
    if (!result.text.trim()) {
      return yield { type: 'paused', code: 'empty_response', message: names[self], state: snapshot() };
    }

    const reply = parseReply(result.text);
    state.positions[self] = reply.position || state.positions[self];
    state.lastBody = reply.body || result.text.trim();
    state.agreeStreak = reply.agree ? state.agreeStreak + 1 : 0;
    if (reply.agree && reply.final) state.lastFinal = reply.final;
    state.totals.tokens += result.usage.input + result.usage.output;
    state.totals.cost += (result.usage.input * (p.priceIn || 0) + result.usage.output * (p.priceOut || 0)) / 1e6;
    state.turn = turn + 1;

    const totals = { ...state.totals };
    yield {
      type: 'turn',
      index: turn,
      name: names[self],
      body: state.lastBody,
      position: reply.position,
      agree: reply.agree,
      usage: result.usage,
      totals,
      state: snapshot(),
    };

    const done = reason => ({ type: 'done', reason, final: state.lastFinal || (reason === 'consensus' ? state.positions[self] : ''), totals });
    if (state.agreeStreak >= 2) return yield done('consensus');
    if (state.totals.tokens >= limits.maxTotalTokens) return yield done('max_tokens');
    if (limits.maxBudget > 0 && state.totals.cost >= limits.maxBudget) return yield done('max_budget');
  }
  yield { type: 'done', reason: 'max_rounds', final: state.lastFinal, totals: { ...state.totals } };
}
