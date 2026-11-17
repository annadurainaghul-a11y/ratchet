import { spend } from "./client.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code) => (text) => (useColor ? `[${code}m${text}[0m` : text);
export const dim = paint("2");
export const bold = paint("1");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const blue = paint("36");

export function pct(value) {
  if (value === null || value === undefined) return "  — ";
  return `${Math.round(value * 100)}%`.padStart(4, " ");
}

function signed(value) {
  if (value === null || value === undefined) return "";
  const points = Math.round(value * 100);
  if (points === 0) return dim("  ±0");
  const text = `${points > 0 ? "+" : ""}${points}`.padStart(4, " ");
  return points > 0 ? green(text) : red(text);
}

const MARK = {
  regressed: red("REGRESSED"),
  improved: green("improved "),
  steady: dim("steady   "),
  new: blue("new      "),
  removed: yellow("removed  ")
};

export function printRun(result, config) {
  const byPrompt = new Map();
  for (const item of result.cases) {
    if (!byPrompt.has(item.promptId)) byPrompt.set(item.promptId, []);
    byPrompt.get(item.promptId).push(item);
  }

  for (const [promptId, cases] of byPrompt) {
    console.log(`\n${bold(promptId)}`);
    for (const item of cases) {
      const rate = item.passRate;
      const label = rate === 1 ? green(pct(rate)) : rate >= 0.5 ? yellow(pct(rate)) : red(pct(rate));
      console.log(`  ${label}  ${dim(`[${item.category}]`)} ${item.name}`);
      if (rate < 1) {
        for (const check of item.checks.filter((c) => c.rate < 1)) {
          console.log(`        ${dim("·")} ${check.key} ${dim(`(${check.passed}/${check.total})`)}`);
          if (check.reasons[0]) console.log(`          ${dim(check.reasons[0])}`);
        }
      }
    }
  }
  console.log(`\n${dim(`${result.cases.length} cases · ${config.samples} samples each`)}`);
}

export function printDiff(report) {
  if (!report.hasBaseline) {
    console.log(yellow("\nNo baseline yet. Run `ratchet accept` to make this run the baseline."));
    return;
  }

  console.log(`\n${bold("Change since baseline")}\n`);
  const moved = [...report.regressions, ...report.improvements, ...report.rows.filter((r) => r.status === "new"), ...report.removed];

  if (!moved.length) {
    console.log(green("  Nothing moved. Quality held."));
  } else {
    for (const row of moved) {
      console.log(
        `  ${MARK[row.status]}  ${pct(row.previousRate)} → ${pct(row.passRate)} ${signed(row.delta)}  ${row.name}`
      );
      if (row.status === "regressed" && row.example?.reasons?.length) {
        console.log(`             ${dim(row.example.reasons[0])}`);
      }
    }
  }

  const overall = `${pct(report.baselineScore)} → ${pct(report.currentScore)}`;
  console.log(`\n  ${bold("Overall")}  ${overall} ${signed(report.scoreDelta)}`);
}

export function printSpend() {
  if (!spend.calls) return;
  console.log(
    dim(
      `\n${spend.calls} model calls · ${spend.inputTokens.toLocaleString()} in · ` +
        `${spend.outputTokens.toLocaleString()} out` +
        (spend.cacheReadTokens ? ` · ${spend.cacheReadTokens.toLocaleString()} cached` : "")
    )
  );
}

/** The pull request comment. Kept terse: nobody reads a long CI comment. */
export function markdownDiff(report, { commit } = {}) {
  const lines = [];
  const verdict = report.failed
    ? `**${report.regressions.length} regression${report.regressions.length === 1 ? "" : "s"}**`
    : "**No regressions**";

  lines.push(`### Ratchet — AI quality ${report.failed ? "slipped" : "held"}`);
  lines.push("");
  lines.push(
    `${verdict} · overall ${Math.round((report.baselineScore ?? 0) * 100)}% → ${Math.round(report.currentScore * 100)}%`
  );
  lines.push("");

  const moved = [...report.regressions, ...report.improvements];
  if (moved.length) {
    lines.push("| | Case | Before | After |");
    lines.push("|---|---|---|---|");
    for (const row of moved) {
      const mark = row.status === "regressed" ? "**down**" : "up";
      lines.push(
        `| ${mark} | ${escapePipes(row.name)} | ${Math.round((row.previousRate ?? 0) * 100)}% | ${Math.round(row.passRate * 100)}% |`
      );
    }
    lines.push("");
  }

  for (const row of report.regressions.slice(0, 3)) {
    if (!row.example) continue;
    lines.push(`<details><summary>Why <code>${escapePipes(row.name)}</code> failed</summary>`);
    lines.push("");
    if (row.example.reasons?.length) {
      for (const reason of row.example.reasons) lines.push(`- ${reason}`);
      lines.push("");
    }
    lines.push("```");
    lines.push(row.example.output || "(no output)");
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }

  if (commit) lines.push(`<sub>Commit \`${commit.slice(0, 7)}\`</sub>`);
  return lines.join("\n");
}

function escapePipes(text) {
  return String(text).replace(/\|/g, "\\|");
}
