# Ratchet

**Regression testing for AI features.** Point it at your repo. It finds your prompts, writes the tests, and fails the build when quality slips.

See the whole thing in ten seconds, no API key, nothing sent anywhere:

```bash
npx prompt-ratchet demo
```

Then on your own code:

```bash
npx prompt-ratchet scan       # find the prompts
npx prompt-ratchet generate   # write the cases
npx prompt-ratchet run        # score them
npx prompt-ratchet accept     # lock in the baseline
```

---

## The problem

Your app has AI features. Someone edits a prompt, swaps a model, or updates the retrieval index — and output quality silently degrades. Your test suite doesn't catch it, because traditional tests assert exact output and LLM output is non-deterministic. You find out from a customer.

Eval platforms exist. Almost nobody uses them, for one reason: **you have to write the test cases yourself**, and writing evals is nobody's job and nobody's promotion. The suite gets written once during a hackathon and rots.

Ratchet writes them.

## The idea it rests on

**An LLM test does not pass or fail. It passes at a rate.**

Run a case once and you learn almost nothing — you sampled a distribution one time. So every case runs several times and Ratchet tracks the *pass rate*. A regression is a rate that dropped by more than the threshold. Anything smaller is sampling noise, and reporting noise as failure is how every flaky suite ends up ignored.

That's why the output looks like this and not like a red X:

```
support-triage
   67%  [adversarial] Refund requested after the 30-day window
        · never says "I'll process that refund" (1/3)
          said "I'll process that refund"
  100%  [typical] Password reset for an existing account
```

## Quickstart

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npx prompt-ratchet scan
npx prompt-ratchet generate
npx prompt-ratchet run
npx prompt-ratchet accept
```

`accept` writes `.ratchet/baseline.json`. Commit it. From then on, `ratchet check` compares against it and exits non-zero when a case regresses.

Everything lives in `.ratchet/` as plain JSON. The generated cases are yours — read them, edit them, delete the ones that are wrong. They are a starting point that exists, which beats a perfect suite that doesn't.

## Commands

| Command | What it does |
|---|---|
| `demo` | The whole loop on canned data. No API key, no network, no config |
| `scan` | Walks the repo, finds calls into a model SDK, extracts prompts and their variables |
| `generate` | Writes regression cases per prompt across typical, edge, adversarial, injection, safety and format |
| `run` | Runs every case `samples` times, applies the checks, scores each case |
| `accept` | Makes the last run the baseline |
| `check` | `run` plus a diff against the baseline. Exits 1 on regression. This is the CI command |
| `list` | What's been found so far |

Flags: `--dir`, `--samples`, `--concurrency`, `--threshold`, `--prompt <id>`, `--comment <file>`, `--json`.

## Checks

Deterministic checks run locally and cost nothing:

`contains` · `not_contains` · `regex` · `json_valid` · `max_words` · `min_words` · `not_refused`

`judge` is the escape hatch for when correctness is genuinely a matter of meaning. It costs a model call per sample, so generation is instructed to prefer deterministic checks and to make every rubric a single checkable statement — `"declines the refund and cites the 30-day window"`, never `"is a good answer"`.

## In CI

```yaml
name: AI quality
on: pull_request

jobs:
  ratchet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: annadurainaghul-a11y/ratchet@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

It posts one comment per pull request and updates it in place rather than stacking new ones.

## Endpoint mode

By default Ratchet re-sends the prompt it extracted, which tests the prompt and nothing else. But a real feature is prompt *plus* retrieval *plus* tool calls *plus* whatever you do to the output — and most production failures live in that "plus".

Point a prompt at your actual handler and Ratchet drives that instead:

```json
{
  "endpoints": {
    "support-triage": {
      "url": "http://localhost:3000/api/support",
      "method": "POST",
      "headers": { "authorization": "Bearer ${SUPPORT_TOKEN}" },
      "body": { "name": "{{customerName}}", "question": "{{question}}" },
      "extract": "reply",
      "timeoutMs": 30000
    }
  }
}
```

`{{variables}}` are substituted anywhere in `url`, `headers` and `body`. `${ENV_VARS}` are read from the environment, so tokens never live in the config file. `extract` is a path into the JSON response — `data.choices[0].message.content` works — and if you omit it, Ratchet looks for the obvious keys (`reply`, `text`, `answer`, `output`, …).

The cases stay exactly the same. Only what answers them changes, so you can generate against the prompt and score against production.

## Configuration

Optional `ratchet.config.json`:

```json
{
  "include": ["src"],
  "samples": 3,
  "concurrency": 4,
  "threshold": 0.34,
  "casesPerPrompt": 8,
  "targetModel": null,
  "endpoints": {}
}
```

`threshold` defaults to `0.34` — roughly one sample in three. `targetModel` overrides the model your prompts are tested against, which is the fastest way to answer "what breaks if we migrate?"

## What it costs

A run is `cases × samples` model calls, plus one more per judge check per sample. Ten cases at three samples is about 30–60 calls. Every command prints its token usage when it finishes.

To keep CI cheap: lower `samples` on pull requests and run the full suite nightly.

## What it doesn't do yet

Being straight about the edges:

- **Discovery needs the prompt to be visible in the source.** Prompts assembled at runtime from a database won't be found. Endpoint mode covers you here — you just have to name the cases' variables yourself.
- **Multi-turn conversations aren't modelled.** Every case is one turn.
- **No hosted history.** Baselines live in your repo. That's a feature at this size and a limitation later.
- **Streaming endpoints need to return a complete body.** SSE isn't parsed yet.

## Development

```bash
npm install
npm test     # 41 tests, no API key needed
npm run demo
```

`test/smoke.js` covers everything that doesn't call a model, so a refactor can be checked for free.

## Licence

MIT
