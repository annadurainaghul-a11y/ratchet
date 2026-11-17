# Contributing

Thanks for looking. Ratchet is small on purpose — two dependencies, no build step, plain ESM that runs straight off disk.

## Getting set up

```bash
git clone <your fork>
cd ratchet
npm install
npm test        # 39 tests, no API key needed
node bin/ratchet.js demo
```

`npm test` covers everything that doesn't call a model, including endpoint mode against a real local HTTP server. It runs in about a second and costs nothing, so run it constantly.

To exercise the paths that do call a model:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node bin/ratchet.js scan --dir examples/demo-app
node bin/ratchet.js generate --dir examples/demo-app
node bin/ratchet.js run --dir examples/demo-app --samples 1
```

Use `--samples 1` while developing. You are paying for every sample.

## How it fits together

```
bin/ratchet.js    entry point, turns thrown errors into exit codes
src/cli.js        argument parsing and command dispatch
src/client.js     every model call goes through here — one place for cost, refusals, retries
src/discover.js   walks the repo, scores candidate files, extracts prompts
src/generate.js   writes the regression cases
src/run.js        executes cases, samples them, aggregates pass rates
src/endpoint.js   drives your HTTP handler instead of the raw prompt
src/checks.js     deterministic checks, plus the LLM judge
src/diff.js       baseline comparison and the regression rule
src/report.js     terminal output and the pull request comment
src/demo.js       canned walkthrough, no API key
```

## Things worth knowing before you change something

**Pass rates, not booleans.** The core idea is that an LLM test passes at a *rate*. If you find yourself adding a code path that reduces a case to pass/fail, stop and reconsider — that change would make the tool flaky and flaky tools get disabled.

**The threshold exists to absorb noise.** `0.34` is roughly one sample in three. Lowering it makes Ratchet louder and less trusted. There's a test asserting that a single wobbling sample does *not* fail the build; please keep it passing.

**Deterministic checks before the judge.** Every judge check costs a model call per sample. New check types should be local wherever the assertion can be expressed locally.

**Structured output is fussy.** `z.record()` cannot be used in a schema sent to the model — it serializes to an object that permits no properties, so the model silently returns nothing usable. Use an array of `{name, value}` and convert after. This bit us once already.

## Adding a check type

1. Add it to the `Check` enum and the normalizer in `src/generate.js`.
2. Implement it in the switch in `src/checks.js`.
3. Add a line to `describeCheck` so failures read as English.
4. Add a test in `test/smoke.js` for both the passing and failing case.

The description matters more than it looks — it's what someone reads in a pull request comment at the moment they're deciding whether to trust the tool.

## Style

Match what's there. Plain ESM, no TypeScript, no build step, no framework. Comments explain *why*, not what — the what is already in the code.

## Reporting a bug

Include the command you ran, what you expected, and what happened. If discovery missed a prompt, a snippet of the code it missed is worth more than any description of it.
