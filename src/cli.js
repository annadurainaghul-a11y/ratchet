import fs from "node:fs";
import path from "node:path";
import { loadConfig, ensureStateDir, stateDir, readJSON, writeJSON } from "./config.js";
import { discover } from "./discover.js";
import { generateSuite } from "./generate.js";
import { runSuites, score } from "./run.js";
import { diff } from "./diff.js";
import { printRun, printDiff, printSpend, markdownDiff, bold, dim, red, green, yellow } from "./report.js";
import { RatchetError } from "./client.js";
import { runDemo } from "./demo.js";

const USAGE = `ratchet — regression testing for AI features

  ratchet demo              see the whole loop on canned data, no API key
  ratchet scan              find the prompts in this repo
  ratchet generate          write regression cases for them
  ratchet run               run the cases and score them
  ratchet accept            make the last run the baseline
  ratchet check             run, compare to baseline, fail on regression
  ratchet list              show what has been found so far

Options
  --dir <path>              project directory (default: .)
  --samples <n>             runs per case (default: 3)
  --concurrency <n>         parallel model calls (default: 4)
  --threshold <0-1>         pass-rate drop that counts as a regression (default: 0.34)
  --prompt <id>             limit to one prompt
  --comment <file>          write a markdown summary for a PR comment
  --json                    machine-readable output
`;

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function resolveConfig(flags) {
  const dir = path.resolve(flags.dir || ".");
  if (!fs.existsSync(dir)) throw new RatchetError(`No such directory: ${dir}`);
  const config = loadConfig(dir);
  if (flags.samples) config.samples = Math.max(1, parseInt(flags.samples, 10) || config.samples);
  if (flags.concurrency) config.concurrency = Math.max(1, parseInt(flags.concurrency, 10) || config.concurrency);
  if (flags.threshold) config.threshold = parseFloat(flags.threshold) || config.threshold;
  if (flags.model) config.targetModel = flags.model;
  return { dir, config };
}

function loadPrompts(dir) {
  const prompts = readJSON(path.join(stateDir(dir), "prompts.json"));
  if (!prompts?.length) {
    throw new RatchetError("No prompts on file. Run `ratchet scan` first.");
  }
  return prompts;
}

function loadSuites(dir, promptFilter) {
  const suiteDir = path.join(stateDir(dir), "suites");
  if (!fs.existsSync(suiteDir)) {
    throw new RatchetError("No cases on file. Run `ratchet generate` first.");
  }
  const suites = fs
    .readdirSync(suiteDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJSON(path.join(suiteDir, name)))
    .filter(Boolean)
    .filter((suite) => !promptFilter || suite.promptId === promptFilter);

  if (!suites.length) {
    throw new RatchetError(
      promptFilter ? `No cases for prompt "${promptFilter}".` : "No cases on file. Run `ratchet generate` first."
    );
  }
  return suites;
}

async function cmdScan({ dir, config }) {
  ensureStateDir(dir);
  console.log(dim(`Scanning ${dir}`));

  const { prompts, scanned } = await discover(dir, config, {
    onProgress: (message) => console.log(dim(`  ${message}`))
  });

  if (!prompts.length) {
    console.log(yellow("\nNo prompts found."));
    console.log(dim("Ratchet looks for calls into a model SDK. If your prompts live somewhere unusual,"));
    console.log(dim("point it at that directory with --dir, or widen `include` in ratchet.config.json."));
    return 0;
  }

  writeJSON(path.join(stateDir(dir), "prompts.json"), prompts);

  console.log(`\n${bold(`Found ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`)} ${dim(`in ${scanned} candidate files`)}\n`);
  for (const prompt of prompts) {
    console.log(`  ${bold(prompt.id)}`);
    console.log(`    ${prompt.purpose}`);
    console.log(dim(`    ${prompt.file}:${prompt.line}${prompt.variables.length ? ` · ${prompt.variables.join(", ")}` : ""}`));
  }
  console.log(dim("\nNext: ratchet generate"));
  return 0;
}

async function cmdGenerate({ dir, config, flags }) {
  const prompts = loadPrompts(dir).filter((p) => !flags.prompt || p.id === flags.prompt);
  if (!prompts.length) throw new RatchetError(`No prompt with id "${flags.prompt}".`);

  ensureStateDir(dir);
  let total = 0;

  for (const prompt of prompts) {
    const suite = await generateSuite(prompt, config, {
      onProgress: (message) => console.log(dim(`  ${message}`))
    });
    writeJSON(path.join(stateDir(dir), "suites", `${prompt.id}.json`), suite);
    total += suite.cases.length;

    const byCategory = suite.cases.reduce((acc, c) => {
      acc[c.category] = (acc[c.category] || 0) + 1;
      return acc;
    }, {});
    console.log(
      `  ${bold(prompt.id)} ${dim(`${suite.cases.length} cases · ${Object.entries(byCategory).map(([k, v]) => `${v} ${k}`).join(", ")}`)}`
    );
  }

  console.log(`\n${bold(`Wrote ${total} cases`)}`);
  console.log(dim("Review them in .ratchet/suites — they are yours to edit.\nNext: ratchet run"));
  return 0;
}

async function cmdRun({ dir, config, flags }) {
  const prompts = loadPrompts(dir);
  const suites = loadSuites(dir, flags.prompt);
  const totalCases = suites.reduce((sum, suite) => sum + suite.cases.length, 0);

  console.log(dim(`Running ${totalCases} cases × ${config.samples} samples`));

  const result = await runSuites({
    prompts,
    suites,
    config,
    onProgress: (done, total) => {
      if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${total}`);
    }
  });
  if (process.stdout.isTTY) process.stdout.write("\r");

  const payload = { ...result, finishedAt: new Date().toISOString(), score: score(result.cases), samples: config.samples };
  writeJSON(path.join(stateDir(dir), "latest.json"), payload);
  writeJSON(path.join(stateDir(dir), "runs", `${payload.finishedAt.replace(/[:.]/g, "-")}.json`), payload);

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  printRun(payload, config);
  console.log(`\n  ${bold("Score")}  ${Math.round(payload.score * 100)}%`);
  return 0;
}

function cmdAccept({ dir }) {
  const latest = readJSON(path.join(stateDir(dir), "latest.json"));
  if (!latest) throw new RatchetError("No run to accept. Run `ratchet run` first.");
  writeJSON(path.join(stateDir(dir), "baseline.json"), latest);
  console.log(green(`Baseline set at ${Math.round(latest.score * 100)}% across ${latest.cases.length} cases.`));
  console.log(dim("Commit .ratchet/baseline.json so CI has something to compare against."));
  return 0;
}

async function cmdCheck({ dir, config, flags }) {
  await cmdRun({ dir, config, flags: { ...flags, json: false } });

  const latest = readJSON(path.join(stateDir(dir), "latest.json"));
  const baseline = readJSON(path.join(stateDir(dir), "baseline.json"));
  const report = diff(baseline, latest, config.threshold);

  printDiff(report);

  if (flags.comment) {
    const file = typeof flags.comment === "string" ? flags.comment : "ratchet-comment.md";
    fs.writeFileSync(file, markdownDiff(report, { commit: process.env.GITHUB_SHA }));
    console.log(dim(`\nWrote ${file}`));
  }

  if (!report.hasBaseline) return 0;
  if (report.failed) {
    console.log(red(`\n${report.regressions.length} regression${report.regressions.length === 1 ? "" : "s"}.`));
    return 1;
  }
  console.log(green("\nQuality held."));
  return 0;
}

function cmdList({ dir }) {
  const prompts = readJSON(path.join(stateDir(dir), "prompts.json"), []);
  const baseline = readJSON(path.join(stateDir(dir), "baseline.json"));

  if (!prompts.length) {
    console.log(dim("Nothing scanned yet. Run `ratchet scan`."));
    return 0;
  }

  for (const prompt of prompts) {
    const suite = readJSON(path.join(stateDir(dir), "suites", `${prompt.id}.json`));
    console.log(`  ${bold(prompt.id)} ${dim(`${suite ? `${suite.cases.length} cases` : "no cases yet"}`)}`);
    console.log(dim(`    ${prompt.file}:${prompt.line}`));
  }
  if (baseline) {
    console.log(dim(`\nBaseline: ${Math.round(baseline.score * 100)}% · ${baseline.cases.length} cases · ${baseline.finishedAt}`));
  }
  return 0;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (!command || args.flags.help || command === "help") {
    console.log(USAGE);
    if (!command) console.log(dim("  New here? Run `ratchet demo` — it needs nothing from you.\n"));
    return 0;
  }

  // The demo touches no files and calls no model, so it runs before any
  // config resolution — a bad cwd should not stop someone evaluating this.
  if (command === "demo") return runDemo({ fast: Boolean(args.flags.fast) });

  const { dir, config } = resolveConfig(args.flags);
  const context = { dir, config, flags: args.flags };

  try {
    switch (command) {
      case "scan": return await cmdScan(context);
      case "generate": return await cmdGenerate(context);
      case "run": return await cmdRun(context);
      case "accept": return cmdAccept(context);
      case "check": return await cmdCheck(context);
      case "list": return cmdList(context);
      default:
        console.error(red(`Unknown command: ${command}`));
        console.log(USAGE);
        return 2;
    }
  } finally {
    if (!args.flags.json) printSpend();
  }
}
