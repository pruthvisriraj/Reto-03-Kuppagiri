# Reto 03: purchase order agent

A chat agent that reads a purchase request package (request, supplier quote, leader approval, optional invoice), validates it against master data and control rules RC1 to RC10, builds the SAP purchase order payload, writes the approval evidence as TXT and PDF, and creates the order in a simulated SAP. Every exception goes back to the analyst for an explicit confirmation.

Design, decisions and risks: see [SOLUCION.md](SOLUCION.md). Threat model: [docs/SECURITY.md](docs/SECURITY.md).

- Repository: `https://github.com/<your-user>/reto-03`
- Live agent: `https://reto-03-po-agent.onrender.com`
- Access key: `5wJVdnU1DHHdVm2wJOQuCGgFbu4gpzh/` (the page asks for it on first load)

The live service runs on Render's free plan and sleeps after 15 minutes without traffic. The first request after a pause takes up to a minute while the container starts.

## Run locally

Requirements: [Bun](https://bun.sh) 1.1 or newer.

```bash
cp .env.example .env        # then set ANTHROPIC_API_KEY
bun install
bun run dev                 # http://localhost:3000
```

No key at hand? Set `LLM_PROVIDER=offline` in `.env`. The chat then runs a scripted test double that calls the same tools in the same order. Use it to try the interface and the confirmation flow. It is not a language model.

With Docker instead of Bun:

```bash
cp .env.example .env
docker compose up --build
```

## Demo without a model

```bash
bun install && bun run demo.ts
```

Runs the six cases in `fixtures/reto-03/solicitudes/` by calling the tools directly, shows idempotency on `sol-001`, shows the gate refusing `sol-004` without confirmation, confirms `sol-004` and `sol-005`, and prints `out/control.csv`. `out/` is wiped at the start of every run, and two runs print the same output.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `offline` (scripted test double, no key). |
| `ANTHROPIC_API_KEY` | empty | Model key. Backend only. Never sent to the browser or written to logs. |
| `LLM_MODEL` | `claude-sonnet-5` | Model id. `claude-haiku-4-5-20251001` is the low-cost option. |
| `LLM_TIMEOUT_MS` | `45000` | Timeout per model call. |
| `LLM_MAX_OUTPUT_TOKENS` | `2048` | Output cap per model call. |
| `MAX_ITERATIONS` | `25` | Max model calls per chat turn. |
| `MAX_TOKENS_PER_SESSION` | `300000` | Token budget per chat session. |
| `MAX_TOKENS_PER_DAY` | `2000000` | Token ceiling across all sessions per UTC day. |
| `PORT` | `3000` | HTTP port. |
| `ACCESS_KEY` | empty | Shared key for the public link. Empty means open. |
| `RATE_LIMIT_PER_MIN` | `20` | Chat messages per minute per client IP. |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy, so the rate limit reads `X-Forwarded-For`. |

## Checks

```bash
bun test               # 67 tests: rules per case, tool safety, confirmation gate, loop limits, adapter, HTTP
bun run typecheck      # tsc --noEmit, strict, no any
bun run check:modulo   # fails if modulo/ drifted from agent/prompt.md or src/knowledge
```

## Deploy: GitHub repository plus Render

GitHub holds the code. GitHub Pages cannot run the agent: the chat needs a server for the agent loop and a place for the API key outside the browser. Render builds the `Dockerfile` straight from the GitHub repository.

1. Push the repository to GitHub:

   ```bash
   git init
   git add .
   git commit -m "Purchase order agent for Reto 03"
   git branch -M main
   git remote add origin https://github.com/<your-user>/reto-03.git
   git push -u origin main
   ```

   `.gitignore` keeps `.env`, `out/` and `node_modules/` out of the repository.

2. In Render: New, Blueprint, connect the GitHub repository. Render reads `render.yaml` and asks for two values: `ANTHROPIC_API_KEY` and `ACCESS_KEY` (a long random string you choose).
3. Wait for the build, open `https://<service-name>.onrender.com/api/health`, then the root URL.
4. Put the repository URL, the live URL and the access key in the Test link section above.

Every push to `main` redeploys. `out/` lives on the container disk and resets on each deploy, which is fine for the defense.

Protect the key on a public link:

- Set a monthly spend limit for the key in the Anthropic Console.
- The server caps messages per IP per minute, tokens per session and tokens per day (`render.yaml` sets 15, 150,000 and 1,000,000).
- Rotate or delete the API key after the selection process.

## Layout

```
agent/prompt.md               behavior (system prompt)
src/knowledge/                process knowledge the agent reads
src/tools/oc.ts               the five oc_* tools (execution)
src/domain/                   parsing, rules RC1-RC10, payload, evidence, control log
src/sap/                      SapAdapter interface and file-backed mock
src/llm/                      provider adapter: anthropic.ts, offline.ts
src/agent/                    agent loop, tool registry, sessions
src/app.ts, src/server.ts     HTTP API, static front, rate limit and daily budget
web/                          chat front (plain HTML, CSS, JS)
modulo/                       bonus: agent packaged for other agent platforms
demo.ts                       tools without a model
render.yaml, Dockerfile       deploy from GitHub to Render
tests/                        bun test
docs/SECURITY.md              threat model mapped to OWASP LLM Top 10 2025
```

## API

| Method | Path | Body or result |
|---|---|---|
| POST | `/api/chat` | `{ sessionId, message, confirm? }` returns `{ reply, toolCalls, needsConfirmation, pendientes }` |
| GET | `/api/sessions/:id` | Session history with tool calls |
| GET | `/api/health` | Provider and model, no secrets |
| GET | `/api/archivos/:caso/:archivo` | `payload.json`, `trazabilidad.json`, `orden.json`, `aprobacion.txt`, `aprobacion.pdf` |
| GET | `/api/control` | `out/control.csv` |

Send the header `x-access-key` when `ACCESS_KEY` is set.

Sessions belong to the browser that created them. The first API call sets a `po_token` cookie (HttpOnly, SameSite=Strict, Secure on HTTPS). A different client using the same `sessionId` gets 403 on chat and an empty history. With curl, keep a cookie jar:

```bash
curl -c cookies.txt -b cookies.txt -H "content-type: application/json" -H "x-access-key: $KEY" \
  -d '{"sessionId":"demo-session-1","message":"Process sol-004"}' https://<service-name>.onrender.com/api/chat
```
