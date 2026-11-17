import fs from "node:fs";
import path from "node:path";

export const DEFAULTS = {
  /** Directories walked when looking for prompts. */
  include: ["."],
  /** Directory names skipped everywhere. */
  exclude: [
    "node_modules", ".git", "dist", "build", "out", "target", "vendor",
    ".next", ".nuxt", ".venv", "venv", "__pycache__", "coverage", ".ratchet"
  ],
  /** How many times each case runs. LLM output is a distribution, not a value. */
  samples: 3,
  /** Parallel model calls during a run. */
  concurrency: 4,
  /** A case regresses when its pass rate drops by more than this. */
  threshold: 0.34,
  /** Model your prompts are tested against. Defaults to whatever discovery found. */
  targetModel: null,
  /** Cap on cases generated per prompt. */
  casesPerPrompt: 8,
  /** Files bigger than this are skipped during discovery. */
  maxFileBytes: 120000,
  /**
   * Per-prompt HTTP handlers. Where a prompt id appears here, Ratchet drives
   * your endpoint instead of re-sending the prompt, so retrieval, tools and
   * post-processing are all under test.
   *
   *   "endpoints": {
   *     "support-triage": {
   *       "url": "http://localhost:3000/api/support",
   *       "method": "POST",
   *       "headers": { "authorization": "Bearer ${SUPPORT_TOKEN}" },
   *       "body": { "name": "{{customerName}}", "question": "{{question}}" },
   *       "extract": "reply"
   *     }
   *   }
   */
  endpoints: {}
};

export const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".py", ".go", ".rb", ".java", ".kt", ".php", ".cs", ".rs"
]);

export function loadConfig(dir) {
  const file = path.join(dir, "ratchet.config.json");
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...DEFAULTS, ...parsed };
  } catch (error) {
    throw new Error(`ratchet.config.json is not valid JSON: ${error.message}`);
  }
}

export function stateDir(dir) {
  return path.join(dir, ".ratchet");
}

export function ensureStateDir(dir) {
  const target = stateDir(dir);
  fs.mkdirSync(path.join(target, "suites"), { recursive: true });
  fs.mkdirSync(path.join(target, "runs"), { recursive: true });
  return target;
}

export function readJSON(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
