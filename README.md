# consensus

Pick two AI models, give them a question or an argument, and let them debate until they agree on an answer.

A small Node.js app meant to run **locally for personal use**. You bring your own API keys; nothing is stored outside your machine and your browser.

## Features

- **Multiple providers:** Anthropic, Google Gemini, OpenAI, Mistral, Groq, DeepSeek, xAI, OpenRouter and Together AI.
- **Model picker:** after adding an API key, the model list is fetched from the provider. Nothing is hardcoded.
- **Turn order:** the order in which you select the two accounts decides who answers first.
- **Cost control:** limits per debate for rounds, tokens per reply, total tokens and estimated budget.
- **Resilient:** handles provider rate limits with automatic retries, and pauses (instead of failing) when a limit or quota blocks the debate.
- **Resumable:** a paused or stopped debate can be resumed later, even after reloading the page, optionally with a different model or account.
- **Continue, clear, export:** if a debate ends without consensus, continue it for a number of extra rounds. Clear the conversation, or export it as Markdown or JSON.
- **i18n ready:** all UI text lives in `locales/*.json`.

## Requirements

- Node.js 18 or newer
- At least two API keys (they can be from the same provider)

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. Use the `PORT` environment variable to change the port.

## Usage

1. **Add accounts:** choose a provider, paste its API key and click *Add account*.
2. **Select exactly two accounts.** Pick a model for each. The badge (1 or 2) shows who answers first.
3. **Write the question or argument.**
4. **Set the limits** (see below). Optionally enter each account's price per 1M tokens to get a cost estimate.
5. **Start the debate.** Replies appear turn by turn. You can stop at any time.
6. **No consensus?** Set the *Extra rounds* and click *Continue* (raise the token or budget limit first if that is what stopped it). Use *Export* to download the conversation.

## How the debate works

Provider APIs are stateless, and resending the whole conversation every turn gets expensive. So each turn is a **single, constant-size request** containing:

- the original question (system prompt),
- the AI's own current position (a 1-2 sentence summary),
- the other AI's latest reply.

Every reply must end with:

```
POSITION: <current position, max 2 sentences>
AGREE: yes|no
FINAL: <agreed answer, only if AGREE is yes>
```

The debate ends when **two consecutive replies** have `AGREE: yes`, or when a limit is reached. The prompt tells both models to critique with substance and not to agree just to be polite.

## Limits

| Limit | Meaning |
| --- | --- |
| Max rounds | One round = one reply from each AI (6 rounds = 12 replies). |
| Max tokens per reply | Output cap sent to the provider on each turn. |
| Max total tokens | Input + output tokens, summed over both AIs. |
| Max budget | Estimated cost in dollars, from the prices you enter per account (0 = off). |

Limits apply **per debate**. The page shows consumption against them as the debate runs.

> Providers do not expose the remaining balance of a regular API key, so the app only shows what *it* has consumed.

## Rate limits and quota errors

- **Temporary limits (429, 503, 529):** the app waits as long as the provider asks (`Retry-After`) or uses exponential backoff, up to 4 retries and 60 s per wait. The page shows the countdown.
- **Longer waits, exhausted quota or invalid key:** no retries. The debate is **paused** and its state is kept.
- **Resume:** click *Resume* once the limit is lifted. Before that, you can change the model of either AI, or deselect the failing account and select another one, which takes the same turn order.

Telling a temporary limit from an exhausted quota relies on the provider's error code and message, so it is a heuristic. A wrong guess only means pausing instead of retrying, or the other way around.

## Data and security

- By default the server listens on `127.0.0.1` only. Set `HOST=0.0.0.0` to expose it (see *Deploying*).
- API keys are stored in your browser's `localStorage` and sent to the local server on each request. The server never writes them to disk.
- The saved debate session (question, transcript, state) is also in `localStorage` and contains **no API keys**.
- Your questions and the model replies are sent to the providers you choose, under their terms.

This is a single-user tool. It has no authentication, so do not expose it to a network as is: anyone with the URL could use the app (with their own keys) and the server would see those keys.

## Deploying

Any Node host works (build command `npm install`, start command `npm start`). The server reads `PORT` from the environment and, when `HOST` is not set, binds to `127.0.0.1`, which a hosting platform cannot reach. Set `HOST=0.0.0.0` (on Render this is picked automatically through the `RENDER` variable). Remember the note above about authentication.

## Project structure

```
server.js        Express server: static files, model listing, debate stream (SSE)
debate.js        Debate engine: prompts, reply parsing, limits, resumable state
providers.js     Provider adapters, retries and error classification
locales/en.json  UI texts
public/          Single-page frontend (index.html)
```

## Adding a provider

If the provider has an OpenAI-compatible API, add one line to `OPENAI_COMPATIBLE` in `providers.js`:

```js
myprovider: { label: 'My Provider', baseUrl: 'https://api.example.com/v1', tokenParam: 'max_tokens' },
```

Otherwise, write an adapter exposing `listModels(apiKey)` and `chat({ apiKey, model, system, messages, maxTokens, signal, onWait })`, returning `{ text, usage: { input, output } }`.

## Adding a language

Copy `locales/en.json` to `locales/<lang>.json` (for example `es.json`) and translate the values. The page picks the browser language and falls back to English.

## Known limitations

- Replies arrive turn by turn, not token by token.
- Gemini models with reasoning spend part of *max tokens per reply* on thinking. If a reply comes back empty, raise that limit.
- Costs are estimates based on the prices you enter.

## License

Add the license of your choice.
