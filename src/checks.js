import { z } from "zod";
import { structured, withRetry } from "./client.js";

/**
 * Deterministic checks run locally and cost nothing. The judge is the
 * expensive one, so it only runs when a rubric asked for it.
 */

export function describeCheck(check) {
  switch (check.type) {
    case "contains": return `contains ${check.values.map(quote).join(" and ")}`;
    case "not_contains": return `never says ${check.values.map(quote).join(" or ")}`;
    case "regex": return `${check.expect ? "matches" : "does not match"} /${check.pattern}/`;
    case "json_valid": return "returns valid JSON";
    case "max_words": return `is at most ${check.count} words`;
    case "min_words": return `is at least ${check.count} words`;
    case "not_refused": return "does not refuse";
    case "judge": return check.rubric;
    default: return check.type;
  }
}

function quote(value) {
  return `"${value}"`;
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function extractJSON(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

const Verdict = z.object({
  passed: z.boolean(),
  reason: z.string().describe("One sentence. If it failed, name the specific thing that was wrong.")
});

const JUDGE_SYSTEM = `You check whether an AI answer satisfies one specific requirement.

Judge only the requirement you are given. Do not reward an answer for being well written, and do not punish it for style, length or tone unless the requirement mentions them. If the requirement is met, pass it, even if the answer could have been better. If you cannot tell, fail it and say what was missing.`;

export async function runJudge({ rubric, output, input, model }) {
  const result = await withRetry(
    () =>
      structured({
        system: JUDGE_SYSTEM,
        user: [
          `REQUIREMENT:\n${rubric}`,
          "",
          `WHAT THE USER SENT:\n${input}`,
          "",
          `WHAT THE AI ANSWERED:\n${output}`,
          "",
          "Does the answer meet the requirement?"
        ].join("\n"),
        schema: Verdict,
        effort: "low",
        maxTokens: 2000
      }),
    { label: "Judge" }
  );
  return result;
}

/**
 * @returns {Promise<Array<{check: object, passed: boolean, reason: string}>>}
 */
export async function applyChecks(checks, output, context) {
  const results = [];

  for (const check of checks) {
    let passed = true;
    let reason = "";

    switch (check.type) {
      case "contains": {
        const missing = check.values.filter(
          (value) => !output.toLowerCase().includes(value.toLowerCase())
        );
        passed = missing.length === 0;
        reason = passed ? "" : `missing ${missing.map(quote).join(", ")}`;
        break;
      }
      case "not_contains": {
        const present = check.values.filter((value) =>
          output.toLowerCase().includes(value.toLowerCase())
        );
        passed = present.length === 0;
        reason = passed ? "" : `said ${present.map(quote).join(", ")}`;
        break;
      }
      case "regex": {
        let matched = false;
        try {
          matched = new RegExp(check.pattern, "i").test(output);
        } catch {
          passed = false;
          reason = `check has an invalid pattern: /${check.pattern}/`;
          break;
        }
        passed = matched === check.expect;
        reason = passed ? "" : check.expect ? "pattern did not match" : "pattern matched when it should not";
        break;
      }
      case "json_valid": {
        passed = extractJSON(output);
        reason = passed ? "" : "output is not parseable JSON";
        break;
      }
      case "max_words": {
        const n = words(output);
        passed = n <= check.count;
        reason = passed ? "" : `${n} words, limit is ${check.count}`;
        break;
      }
      case "min_words": {
        const n = words(output);
        passed = n >= check.count;
        reason = passed ? "" : `${n} words, minimum is ${check.count}`;
        break;
      }
      case "not_refused": {
        passed = !context.refused && output.trim().length > 0;
        reason = passed ? "" : "the model declined or returned nothing";
        break;
      }
      case "judge": {
        if (!output.trim()) {
          passed = false;
          reason = "there was no answer to judge";
          break;
        }
        try {
          const verdict = await runJudge({
            rubric: check.rubric,
            output,
            input: context.renderedInput,
            model: context.model
          });
          passed = verdict.passed;
          reason = passed ? "" : verdict.reason;
        } catch (error) {
          passed = false;
          reason = `judge could not run: ${error.message}`;
        }
        break;
      }
      default:
        continue;
    }

    results.push({ check, passed, reason });
  }

  return results;
}
