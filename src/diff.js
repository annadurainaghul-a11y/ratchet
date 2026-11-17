import { score } from "./run.js";

/**
 * A regression is a pass rate that fell by more than the threshold. Anything
 * smaller is sampling noise and reporting it as a failure would train people
 * to ignore the tool, which is how every flaky test suite dies.
 */

export function diff(baseline, current, threshold) {
  const before = new Map((baseline?.cases || []).map((item) => [item.caseId, item]));
  const rows = [];

  for (const item of current.cases) {
    const previous = before.get(item.caseId);
    const delta = previous ? item.passRate - previous.passRate : null;

    let status;
    if (!previous) status = "new";
    else if (delta <= -threshold) status = "regressed";
    else if (delta >= threshold) status = "improved";
    else status = "steady";

    rows.push({
      ...item,
      previousRate: previous ? previous.passRate : null,
      delta,
      status
    });
    before.delete(item.caseId);
  }

  const removed = [...before.values()].map((item) => ({ ...item, status: "removed" }));

  const regressions = rows.filter((row) => row.status === "regressed");
  const improvements = rows.filter((row) => row.status === "improved");
  const currentScore = score(current.cases);
  const baselineScore = baseline ? score(baseline.cases) : null;

  return {
    rows,
    removed,
    regressions,
    improvements,
    currentScore,
    baselineScore,
    scoreDelta: baselineScore === null ? null : currentScore - baselineScore,
    hasBaseline: Boolean(baseline),
    failed: regressions.length > 0
  };
}
