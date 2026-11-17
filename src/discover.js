import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { structured, withRetry } from "./client.js";
import { SOURCE_EXTENSIONS } from "./config.js";

/**
 * Discovery is the whole zero-config promise: you point Ratchet at a repo and
 * it finds the prompts. Regex gets us recall over any language; the model
 * turns candidates into structured records.
 */

const SIGNALS = [
  { pattern: /messages\.(create|stream|parse)/g, weight: 10 },
  { pattern: /chat\.completions\.create/g, weight: 10 },
  { pattern: /generateText|generateObject|streamText/g, weight: 8 },
  { pattern: /invoke_?model/gi, weight: 6 },
  { pattern: /anthropic|openai|@ai-sdk|langchain|bedrock/gi, weight: 3 },
  { pattern: /system[_-]?prompt|SYSTEM_PROMPT/g, weight: 5 },
  { pattern: /\bprompt\b/gi, weight: 1 }
];

const PromptRecord = z.object({
  name: z.string().describe("Short human name, e.g. 'Support triage classifier'"),
  file: z.string().describe("Repo-relative path exactly as given in the header"),
  line: z.number().describe("1-indexed line where the prompt is defined"),
  purpose: z.string().describe("One sentence: what this prompt is for in the product"),
  system: z.string().nullable().describe("System prompt text, or null if there is none"),
  template: z.string().describe("The user-facing prompt text with {{variable}} placeholders"),
  variables: z.array(z.string()).describe("Names of the {{variable}} placeholders used"),
  model: z.string().nullable().describe("Model id if the code names one"),
  outputKind: z.enum(["text", "json", "classification", "unknown"])
});

const Discovery = z.object({ prompts: z.array(PromptRecord) });

export function walk(root, exclude, maxFileBytes) {
  const found = [];
  const skip = new Set(exclude);

  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (skip.has(entry.name) || entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > maxFileBytes || stat.size === 0) continue;
        found.push(full);
      }
    }
  }

  visit(root);
  return found;
}

export function scoreFile(text) {
  let score = 0;
  for (const signal of SIGNALS) {
    const matches = text.match(signal.pattern);
    if (matches) score += Math.min(matches.length, 5) * signal.weight;
  }
  return score;
}

export function candidates(root, config) {
  const files = [];
  for (const includeDir of config.include) {
    const base = path.resolve(root, includeDir);
    if (!fs.existsSync(base)) continue;
    files.push(...walk(base, config.exclude, config.maxFileBytes));
  }

  const scored = [];
  for (const file of new Set(files)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const score = scoreFile(text);
    if (score < 8) continue;
    scored.push({ file, relative: path.relative(root, file), text, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

function chunk(files, maxChars) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    const cost = file.text.length + file.relative.length + 40;
    if (size + cost > maxChars && current.length) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function numbered(text) {
  return text
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`)
    .join("\n");
}

const SYSTEM = `You read source code and extract the LLM prompts it sends to a model.

Rules:
- Report only prompts that are actually sent to a language model. Ignore log strings, CLI help text, comments and test fixtures.
- Reconstruct the full prompt text, following any constants or helper functions that are visible in the files given to you.
- Where the code interpolates a value, replace it with a {{snake_case}} placeholder and list the name in variables.
- Report the file path exactly as it appears in the ==== FILE: header, and a line number from the gutter.
- If a prompt is assembled from several pieces, report it once, assembled.
- Return an empty array rather than guessing when no real prompt is present.`;

export async function discover(root, config, { onProgress } = {}) {
  const files = candidates(root, config);
  if (!files.length) return { prompts: [], scanned: 0 };

  const batches = chunk(files, 45000);
  const all = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onProgress?.(`Reading batch ${i + 1} of ${batches.length} (${batch.length} files)`);

    const body = batch
      .map((file) => `==== FILE: ${file.relative}\n${numbered(file.text)}`)
      .join("\n\n");

    const result = await withRetry(
      () =>
        structured({
          system: SYSTEM,
          user: `Extract every LLM prompt defined in these files.\n\n${body}`,
          schema: Discovery,
          effort: "high"
        }),
      { label: "Prompt discovery" }
    );

    all.push(...result.prompts);
  }

  return { prompts: dedupe(all), scanned: files.length };
}

export function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "prompt";
}

function dedupe(prompts) {
  const seen = new Map();
  for (const prompt of prompts) {
    const base = slug(prompt.name);
    let id = base;
    let n = 2;
    while (seen.has(id) && seen.get(id).file !== prompt.file) {
      id = `${base}-${n++}`;
    }
    if (seen.has(id)) continue;
    seen.set(id, { id, ...prompt });
  }
  return [...seen.values()];
}
