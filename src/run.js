import { completion, withRetry } from "./client.js";
import { applyChecks, describeCheck } from "./checks.js";
import { callEndpoint } from "./endpoint.js";

/**
 * The idea this whole tool rests on: an LLM test does not pass or fail, it
 * passes at a rate. One sample tells you almost nothing, so every case runs
 * several times and we track the rate. Regression then means the rate dropped,
 * which is a claim you can actually defend in a pull request.
 */

export function render(template, variables) {
  if (!template) return "";
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
    const value = variables?.[name];
    return value === undefined || value === null ? match : String(value);
  });
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function drain() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

export async function runSuites({ prompts, suites, config, onProgress }) {
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const tasks = [];

  for (const suite of suites) {
    const prompt = byId.get(suite.promptId);
    if (!prompt) continue;
    for (const testCase of suite.cases) {
      for (let sample = 0; sample < config.samples; sample++) {
        tasks.push({ prompt, testCase, sample });
      }
    }
  }

  if (!tasks.length) return { cases: [], startedAt: new Date().toISOString() };

  let done = 0;
  const raw = await pool(tasks, config.concurrency, async (task) => {
    const model = config.targetModel || task.prompt.model || undefined;
    const system = render(task.prompt.system, task.testCase.variables) || null;
    const user = render(task.prompt.template, task.testCase.variables);
    const endpoint = config.endpoints?.[task.prompt.id];

    let output = "";
    let refused = false;
    let error = null;

    if (endpoint) {
      // Endpoint mode: your handler answers, so retrieval, tools and
      // post-processing are all in scope. A 500 is a failure, not a retry.
      const response = await callEndpoint(endpoint, task.testCase.variables, render);
      output = response.text;
      error = response.error;
    } else {
      try {
        const response = await withRetry(
          () => completion({ system, user, model, maxTokens: 2000 }),
          { label: `Case ${task.testCase.id}` }
        );
        output = response.text;
        refused = response.refused;
      } catch (caught) {
        error = caught.message;
      }
    }

    const checkResults = error
      ? task.testCase.checks.map((check) => ({
          check,
          passed: false,
          reason: `${endpoint ? "endpoint" : "model"} call failed: ${error}`
        }))
      : await applyChecks(task.testCase.checks, output, {
          refused,
          renderedInput: user,
          model
        });

    done += 1;
    onProgress?.(done, tasks.length);

    return {
      promptId: task.prompt.id,
      caseId: task.testCase.id,
      sample: task.sample,
      output,
      error,
      checkResults
    };
  });

  return { cases: aggregate(raw, suites), startedAt: new Date().toISOString() };
}

function aggregate(raw, suites) {
  const meta = new Map();
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      meta.set(testCase.id, { suite, testCase });
    }
  }

  const grouped = new Map();
  for (const result of raw) {
    if (!grouped.has(result.caseId)) grouped.set(result.caseId, []);
    grouped.get(result.caseId).push(result);
  }

  const cases = [];
  for (const [caseId, samples] of grouped) {
    const info = meta.get(caseId);
    if (!info) continue;

    const passedSamples = samples.filter((sample) =>
      sample.checkResults.every((result) => result.passed)
    ).length;

    // Per-check rates make a failure legible: you see which assertion moved.
    const checkStats = new Map();
    for (const sample of samples) {
      for (const result of sample.checkResults) {
        const key = describeCheck(result.check);
        if (!checkStats.has(key)) checkStats.set(key, { key, type: result.check.type, passed: 0, total: 0, reasons: [] });
        const stat = checkStats.get(key);
        stat.total += 1;
        if (result.passed) stat.passed += 1;
        else if (result.reason && stat.reasons.length < 3) stat.reasons.push(result.reason);
      }
    }

    const failing = samples.find((sample) => sample.checkResults.some((r) => !r.passed));

    cases.push({
      promptId: info.suite.promptId,
      caseId,
      name: info.testCase.name,
      category: info.testCase.category,
      samples: samples.length,
      passed: passedSamples,
      passRate: samples.length ? passedSamples / samples.length : 0,
      checks: [...checkStats.values()].map((stat) => ({
        ...stat,
        rate: stat.total ? stat.passed / stat.total : 0
      })),
      example: failing
        ? { output: truncate(failing.output, 600), reasons: failing.checkResults.filter((r) => !r.passed).map((r) => r.reason) }
        : null
    });
  }

  return cases.sort((a, b) => a.promptId.localeCompare(b.promptId) || a.caseId.localeCompare(b.caseId));
}

function truncate(text, limit) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function score(cases) {
  if (!cases.length) return 0;
  return cases.reduce((sum, item) => sum + item.passRate, 0) / cases.length;
}
