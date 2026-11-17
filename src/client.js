import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

/**
 * Every model call Ratchet makes goes through here, so there is one place to
 * reason about cost, refusals and retries.
 */

export const AUTHOR_MODEL = process.env.RATCHET_MODEL || "claude-opus-5";

export class RatchetError extends Error {}

let cached = null;

export function client() {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      // The SDK also resolves an `ant auth login` profile, so this is a hint
      // rather than a hard failure — let the SDK make the final call.
      process.env.RATCHET_KEY_HINT = "1";
    }
    cached = new Anthropic();
  }
  return cached;
}

/** Running tally so `ratchet` can report what a command cost. */
export const spend = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0
};

function record(usage) {
  if (!usage) return;
  spend.calls += 1;
  spend.inputTokens += usage.input_tokens || 0;
  spend.outputTokens += usage.output_tokens || 0;
  spend.cacheReadTokens += usage.cache_read_input_tokens || 0;
}

function refusalMessage(response) {
  const category = response.stop_details?.category || "unspecified";
  return `The model declined this request (${category}). Nothing was written.`;
}

/**
 * Ask for JSON matching a Zod schema. Used for discovery, generation and
 * judging, where a shape we can rely on matters more than prose.
 */
export async function structured({ system, user, schema, effort = "high", maxTokens = 16000 }) {
  const response = await client().messages.parse({
    model: AUTHOR_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: zodOutputFormat(schema), effort }
  });

  record(response.usage);

  if (response.stop_reason === "refusal") throw new RatchetError(refusalMessage(response));
  if (!response.parsed_output) {
    throw new RatchetError("The model replied with something that did not match the expected shape.");
  }
  return response.parsed_output;
}

/**
 * Plain text completion. This is what actually exercises the user's prompt
 * under test, so the model is theirs to choose, not ours.
 */
export async function completion({ system, user, model, maxTokens = 2000, effort }) {
  const request = {
    model: model || AUTHOR_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: user }]
  };
  if (system) request.system = system;
  if (effort) request.output_config = { effort };

  const response = await client().messages.create(request);
  record(response.usage);

  if (response.stop_reason === "refusal") {
    return { text: "", refused: true, stopReason: "refusal" };
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return { text, refused: false, stopReason: response.stop_reason };
}

/** Retry only the transient failures. A 400 means our request is wrong. */
export async function withRetry(fn, { attempts = 3, label = "request" } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status;
      const retryable = status === 429 || status === 408 || status === 409 || (status >= 500 && status < 600) || status === undefined;
      if (!retryable || i === attempts - 1) break;
      const wait = Math.min(8000, 500 * 2 ** i) + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new RatchetError(`${label} failed: ${lastError?.message || String(lastError)}`);
}
