/**
 * Endpoint mode.
 *
 * Prompt mode re-sends the prompt Ratchet extracted, which tests the prompt and
 * nothing else. Real features are prompt plus retrieval plus tool calls plus
 * whatever post-processing you do, and most production failures live in that
 * "plus". Endpoint mode drives your actual HTTP handler instead, so what gets
 * scored is what your users would have received.
 */

export class EndpointError extends Error {}

/** `${VAR}` reads from the environment, so tokens stay out of the config file. */
export function resolveEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new EndpointError(`${match} is not set in the environment.`);
    }
    return found;
  });
}

/** Substitute {{variables}} anywhere in a nested structure. */
export function renderDeep(value, variables, render) {
  if (typeof value === "string") return resolveEnv(render(value, variables));
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, variables, render));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = renderDeep(inner, variables, render);
    }
    return out;
  }
  return value;
}

/** Reads `data.choices[0].message.content` style paths. */
export function readPath(payload, expression) {
  const parts = String(expression)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current = payload;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

const LIKELY_KEYS = ["text", "reply", "answer", "output", "message", "content", "result", "response", "completion"];

/** Without an `extract` path, make a sensible guess rather than failing. */
export function extractText(payload, expression) {
  if (typeof payload === "string") return payload;

  if (expression) {
    const found = readPath(payload, expression);
    if (found === undefined || found === null) {
      throw new EndpointError(
        `No value at "${expression}" in the response. Got keys: ${Object.keys(payload || {}).join(", ") || "none"}`
      );
    }
    return typeof found === "string" ? found : JSON.stringify(found);
  }

  for (const key of LIKELY_KEYS) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  return JSON.stringify(payload);
}

/**
 * @returns {Promise<{text: string, refused: boolean, status: number|null, error: string|null}>}
 */
export async function callEndpoint(spec, variables, render) {
  const method = (spec.method || "POST").toUpperCase();
  const timeoutMs = spec.timeoutMs || 30000;

  let url;
  let headers;
  let body;
  try {
    url = renderDeep(spec.url, variables, render);
    headers = renderDeep(spec.headers || {}, variables, render);
    body = spec.body === undefined ? undefined : renderDeep(spec.body, variables, render);
  } catch (error) {
    return { text: "", refused: false, status: null, error: error.message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const request = {
      method,
      headers: { ...headers },
      signal: controller.signal
    };

    if (method !== "GET" && method !== "HEAD" && body !== undefined) {
      if (typeof body === "string") {
        request.body = body;
        request.headers["content-type"] ||= "text/plain";
      } else {
        request.body = JSON.stringify(body);
        request.headers["content-type"] ||= "application/json";
      }
    }

    const response = await fetch(url, request);
    const raw = await response.text();

    if (!response.ok) {
      return {
        text: "",
        refused: false,
        status: response.status,
        error: `${response.status} ${response.statusText}: ${raw.slice(0, 300)}`
      };
    }

    let payload = raw;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      try {
        payload = JSON.parse(raw);
      } catch {
        return { text: "", refused: false, status: response.status, error: "Response claimed JSON but did not parse." };
      }
    }

    return {
      text: extractText(payload, spec.extract),
      refused: false,
      status: response.status,
      error: null
    };
  } catch (error) {
    if (error.name === "AbortError") {
      return { text: "", refused: false, status: null, error: `No response within ${timeoutMs}ms.` };
    }
    const hint = /ECONNREFUSED|fetch failed/i.test(error.message)
      ? ` — is the server at ${typeof url === "string" ? url : "that address"} running?`
      : "";
    return { text: "", refused: false, status: null, error: `${error.message}${hint}` };
  } finally {
    clearTimeout(timer);
  }
}
