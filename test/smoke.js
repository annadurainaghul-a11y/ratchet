import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { callEndpoint, extractText, readPath, renderDeep, resolveEnv } from "../src/endpoint.js";
import { candidates, scoreFile, slug } from "../src/discover.js";
import { applyChecks, describeCheck } from "../src/checks.js";
import { render, score } from "../src/run.js";
import { diff } from "../src/diff.js";
import { markdownDiff } from "../src/report.js";
import { DEFAULTS } from "../src/config.js";
import { parseArgs, main } from "../src/cli.js";

/**
 * Covers everything that does not call a model, so a broken refactor is caught
 * without spending a cent. Run with: node test/smoke.js
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

console.log("\ndiscovery");

check("scores a file that calls a model SDK above the threshold", () => {
  const text = `const r = await client.messages.create({ system: SYSTEM_PROMPT });`;
  assert.ok(scoreFile(text) >= 8, `score was ${scoreFile(text)}`);
});

check("ignores a file with no model calls", () => {
  assert.ok(scoreFile("export function add(a, b) { return a + b; }") < 8);
});

check("finds the demo app as a candidate", () => {
  const found = candidates(path.join(root, "examples/demo-app"), DEFAULTS);
  assert.equal(found.length, 1);
  assert.ok(found[0].relative.endsWith("support.js"));
});

check("skips node_modules", () => {
  const found = candidates(root, DEFAULTS);
  assert.ok(!found.some((f) => f.relative.includes("node_modules")));
});

check("slug is filesystem and url safe", () => {
  assert.equal(slug("Support Triage: refunds!"), "support-triage-refunds");
  assert.equal(slug("!!!"), "prompt");
});

console.log("\nrendering");

check("substitutes variables", () => {
  assert.equal(render("Hello {{name}}, plan {{plan}}", { name: "Ada", plan: "Pro" }), "Hello Ada, plan Pro");
});

check("tolerates whitespace in placeholders", () => {
  assert.equal(render("{{ name }}", { name: "Ada" }), "Ada");
});

check("leaves an unknown placeholder visible rather than printing undefined", () => {
  assert.equal(render("Hi {{missing}}", {}), "Hi {{missing}}");
});

check("handles a null template", () => {
  assert.equal(render(null, {}), "");
});

console.log("\nchecks");

await checkAsync("contains passes case-insensitively", async () => {
  const [result] = await applyChecks([{ type: "contains", values: ["30-day"] }], "Our 30-Day window applies.", {});
  assert.equal(result.passed, true);
});

await checkAsync("contains fails and names what was missing", async () => {
  const [result] = await applyChecks([{ type: "contains", values: ["refund", "policy"] }], "No.", {});
  assert.equal(result.passed, false);
  assert.match(result.reason, /refund/);
});

await checkAsync("not_contains catches a forbidden phrase", async () => {
  const [result] = await applyChecks(
    [{ type: "not_contains", values: ["I'll process that refund"] }],
    "Sure, I'll process that refund right away.",
    {}
  );
  assert.equal(result.passed, false);
});

await checkAsync("json_valid accepts a fenced code block", async () => {
  const [result] = await applyChecks([{ type: "json_valid" }], '```json\n{"label":"billing"}\n```', {});
  assert.equal(result.passed, true);
});

await checkAsync("json_valid rejects prose", async () => {
  const [result] = await applyChecks([{ type: "json_valid" }], "The label is billing.", {});
  assert.equal(result.passed, false);
});

await checkAsync("max_words counts correctly", async () => {
  const [result] = await applyChecks([{ type: "max_words", count: 3 }], "one two three four", {});
  assert.equal(result.passed, false);
  assert.match(result.reason, /4 words/);
});

await checkAsync("not_refused fails on a refusal", async () => {
  const [result] = await applyChecks([{ type: "not_refused" }], "", { refused: true });
  assert.equal(result.passed, false);
});

await checkAsync("an invalid regex fails the check instead of crashing", async () => {
  const [result] = await applyChecks([{ type: "regex", pattern: "([", expect: true }], "anything", {});
  assert.equal(result.passed, false);
  assert.match(result.reason, /invalid pattern/);
});

check("every check type has a readable description", () => {
  const types = [
    { type: "contains", values: ["a"] },
    { type: "not_contains", values: ["b"] },
    { type: "regex", pattern: "x", expect: true },
    { type: "json_valid" },
    { type: "max_words", count: 5 },
    { type: "min_words", count: 2 },
    { type: "not_refused" },
    { type: "judge", rubric: "declines politely" }
  ];
  for (const check of types) {
    const text = describeCheck(check);
    assert.ok(text && text !== check.type, `no description for ${check.type}`);
  }
});

console.log("\nscoring and diff");

const baseCase = (caseId, passRate) => ({
  promptId: "triage",
  caseId,
  name: caseId,
  category: "typical",
  samples: 3,
  passed: Math.round(passRate * 3),
  passRate,
  checks: [],
  example: null
});

check("score averages pass rates", () => {
  assert.equal(score([baseCase("a", 1), baseCase("b", 0)]), 0.5);
});

check("score of nothing is zero, not NaN", () => {
  assert.equal(score([]), 0);
});

check("a real drop is a regression", () => {
  const report = diff(
    { cases: [baseCase("a", 1)] },
    { cases: [baseCase("a", 0.333)] },
    DEFAULTS.threshold
  );
  assert.equal(report.failed, true);
  assert.equal(report.regressions.length, 1);
});

check("one flaky sample is not a regression", () => {
  const report = diff(
    { cases: [baseCase("a", 1)] },
    { cases: [baseCase("a", 0.667)] },
    DEFAULTS.threshold
  );
  assert.equal(report.failed, false, "a single flaky sample must not fail the build");
});

check("an improvement never fails the build", () => {
  const report = diff({ cases: [baseCase("a", 0)] }, { cases: [baseCase("a", 1)] }, DEFAULTS.threshold);
  assert.equal(report.failed, false);
  assert.equal(report.improvements.length, 1);
});

check("a new case is reported but does not fail", () => {
  const report = diff({ cases: [] }, { cases: [baseCase("a", 0.5)] }, DEFAULTS.threshold);
  assert.equal(report.rows[0].status, "new");
  assert.equal(report.failed, false);
});

check("a removed case is surfaced", () => {
  const report = diff({ cases: [baseCase("a", 1)] }, { cases: [] }, DEFAULTS.threshold);
  assert.equal(report.removed.length, 1);
});

check("no baseline means nothing to fail against", () => {
  const report = diff(null, { cases: [baseCase("a", 0)] }, DEFAULTS.threshold);
  assert.equal(report.hasBaseline, false);
  assert.equal(report.failed, false);
});

console.log("\nreporting");

check("markdown escapes pipes so the table survives", () => {
  const report = diff(
    { cases: [baseCase("a", 1)] },
    { cases: [{ ...baseCase("a", 0), name: "refund | edge case" }] },
    DEFAULTS.threshold
  );
  const md = markdownDiff(report, { commit: "abcdef1234" });
  assert.ok(md.includes("refund \\| edge case"));
  assert.ok(md.includes("abcdef1"));
});

check("markdown says quality held when nothing moved", () => {
  const report = diff({ cases: [baseCase("a", 1)] }, { cases: [baseCase("a", 1)] }, DEFAULTS.threshold);
  assert.ok(markdownDiff(report).includes("held"));
});

console.log("\nendpoint mode");

check("readPath walks dots and array indexes", () => {
  const payload = { data: { choices: [{ message: { content: "hello" } }] } };
  assert.equal(readPath(payload, "data.choices[0].message.content"), "hello");
  assert.equal(readPath(payload, "data.nope.deep"), undefined);
});

check("extractText guesses a likely key when no path is given", () => {
  assert.equal(extractText({ reply: "sure thing" }), "sure thing");
  assert.equal(extractText("plain body"), "plain body");
});

check("extractText names the available keys when the path is wrong", () => {
  assert.throws(() => extractText({ a: 1, b: 2 }, "missing"), /a, b/);
});

check("resolveEnv substitutes and complains about a missing variable", () => {
  process.env.RATCHET_TEST_TOKEN = "abc123";
  assert.equal(resolveEnv("Bearer ${RATCHET_TEST_TOKEN}"), "Bearer abc123");
  assert.throws(() => resolveEnv("${RATCHET_TEST_ABSENT}"), /not set/);
});

check("renderDeep substitutes through nested objects", () => {
  const out = renderDeep(
    { q: "{{question}}", meta: { tags: ["{{plan}}"] } },
    { question: "where is my refund", plan: "Pro" },
    render
  );
  assert.equal(out.q, "where is my refund");
  assert.equal(out.meta.tags[0], "Pro");
});

// A real server, so this exercises fetch, JSON handling and error paths.
const received = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url === "/boom") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream exploded");
      return;
    }
    if (req.url === "/notjson") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json");
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reply: "too late" }));
      }, 200);
      return;
    }
    const parsed = body ? JSON.parse(body) : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reply: `answered: ${parsed.question ?? ""}` }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await checkAsync("calls the endpoint and extracts the answer", async () => {
  const result = await callEndpoint(
    {
      url: `${base}/api`,
      method: "POST",
      headers: { authorization: "Bearer ${RATCHET_TEST_TOKEN}" },
      body: { question: "{{question}}" },
      extract: "reply"
    },
    { question: "where is my refund" },
    render
  );
  assert.equal(result.error, null);
  assert.equal(result.text, "answered: where is my refund");
  assert.equal(received.at(-1).auth, "Bearer abc123");
});

await checkAsync("a 500 becomes a readable failure, not a crash", async () => {
  const result = await callEndpoint({ url: `${base}/boom`, body: {} }, {}, render);
  assert.match(result.error, /500/);
  assert.match(result.error, /upstream exploded/);
  assert.equal(result.text, "");
});

await checkAsync("a lying content-type is reported clearly", async () => {
  const result = await callEndpoint({ url: `${base}/notjson`, body: {} }, {}, render);
  assert.match(result.error, /did not parse/);
});

await checkAsync("a timeout is reported with the limit", async () => {
  const result = await callEndpoint({ url: `${base}/slow`, body: {}, timeoutMs: 50 }, {}, render);
  assert.match(result.error, /No response within 50ms/);
});

await checkAsync("a dead server suggests the obvious cause", async () => {
  const result = await callEndpoint({ url: "http://127.0.0.1:1/api", body: {} }, {}, render);
  assert.match(result.error, /running\?/);
});

await new Promise((resolve) => server.close(resolve));

console.log("\ncli");

check("parses flags with values and bare flags", () => {
  const args = parseArgs(["check", "--samples", "5", "--json", "--dir", "./x"]);
  assert.equal(args._[0], "check");
  assert.equal(args.flags.samples, "5");
  assert.equal(args.flags.json, true);
  assert.equal(args.flags.dir, "./x");
});

await checkAsync("demo runs with no key, no network and no config", async () => {
  const real = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  let code;
  try {
    code = await main(["demo", "--fast"]);
  } finally {
    console.log = real;
  }
  const output = lines.join("\n");
  assert.equal(code, 0);
  assert.match(output, /REGRESSED/, "the demo must show a regression — that is the whole point");
  assert.match(output, /Refund requested after the 30-day window/);
  assert.ok(output.includes("67%"), "the demo must show the case that wobbled but held");
});

await checkAsync("bare invocation points a newcomer at the demo", async () => {
  const real = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await main([]);
  } finally {
    console.log = real;
  }
  assert.match(lines.join("\n"), /ratchet demo/);
});

console.log(`\n${passed} passed${process.exitCode ? " with failures" : ""}\n`);
