import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { advertisedCapabilities, familyFromHeaders, familyFromModel } from "./lib/families.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);
const BASELINE_RUNS = 3;
const CATALOG_RECHECK_DELAY_MS = 300;
const MODEL_CONCURRENCY = 3;
const MAX_PROBE_RETRIES = 1;
const PROBE_BACKOFF_MS = 2000;
const configuredTimeout = Number(process.env.PROBE_TIMEOUT_MS);
const PROBE_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 18_000;
const MAX_PROBE_TOKENS_PER_RUN = Number(process.env.MAX_PROBE_TOKENS_PER_RUN) || 20_000;
const MAX_MODELS_PER_RUN = Number(process.env.MAX_MODELS_PER_RUN) || 5;
const TEMPERATURE_REJECTION = /temperature|unsupported (parameter|value)|reasoning/i;
const HOSTED_SSRF_GUARD = process.env.HOSTED_SSRF_GUARD === "1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const SAFE_HEADER_NAMES = [
  "server",
  "via",
  "x-request-id",
  "openai-version",
  "openai-processing-ms",
  "openai-organization",
  "anthropic-request-id",
  "anthropic-ratelimit-requests-limit",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-goog-request-id",
  "x-amzn-requestid",
  "cf-ray",
  "x-served-by",
  "x-cache",
  "x-envoy-upstream-service-time",
];

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function normalizeEndpoint(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("Enter an API endpoint.");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a complete endpoint URL, including https://.");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Only HTTP(S) endpoints are supported.");
  }
  const hostname = url.hostname.replace(/\.$/, "");
  const loopback = hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Use HTTPS for non-local endpoints. Plain HTTP would expose the API key.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the API key field, not in the URL.");
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(/\/(chat\/completions|responses|models)\/?$/, "")
    .replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function endpointUrl(base, suffix) {
  const path = new URL(base).pathname.replace(/\/$/, "");
  const hasVersionedPath = /\/v\d+[a-z0-9-]*(\/|$)/i.test(path);
  const normalized = hasVersionedPath ? base : `${base}/v1`;
  return `${normalized}${suffix}`;
}

function isPrivateAddress(address) {
  const ip = String(address || "").toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return true;
    if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
    if (ip.startsWith("::ffff:")) return isPrivateAddress(ip.slice(7));
    return false;
  }
  return false;
}

async function assertNotPrivateTarget(url) {
  if (!HOSTED_SSRF_GUARD) return;
  const host = new URL(url).hostname.replace(/\.$/, "").toLowerCase();
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error("The endpoint is a private or loopback address, which is blocked for SSRF protection.");
    }
    return;
  }
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error("Could not resolve the endpoint host.");
  }
  if (!records.length || records.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("The endpoint resolves to a private or loopback address, which is blocked for SSRF protection.");
  }
}

function headers(apiKey) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "user-agent": "model-endpoint-verifier/0.1",
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeout = PROBE_TIMEOUT_MS, consume = responseJson) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(fetchFn, { retries = MAX_PROBE_RETRIES, backoffMs = PROBE_BACKOFF_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await fetchFn();
      if (attempt > 0 && result && typeof result === "object" && !Array.isArray(result)) {
        Object.defineProperty(result, "__retries", { value: attempt, enumerable: false, configurable: true });
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      if (error?.name === "AbortError") break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchStreamText(url, options = {}, timeout = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "error" });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const data = JSON.parse(result);
        detail = data?.error?.message || data?.message || detail;
      } catch {}
      throw new Error(detail);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function withoutTemperature(payload, error) {
  if (!("temperature" in payload) || !TEMPERATURE_REJECTION.test(String(error?.message || ""))) return null;
  const { temperature, ...rest } = payload;
  return rest;
}

async function chatJsonRequest({ base, apiKey, payload, timeout = PROBE_TIMEOUT_MS, consume = responseJson }) {
  const send = (body) => fetchJsonWithTimeout(endpointUrl(base, "/chat/completions"), {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  }, timeout, consume);
  try {
    return await send(payload);
  } catch (error) {
    const fallback = withoutTemperature(payload, error);
    if (!fallback) throw error;
    return send(fallback);
  }
}

async function chatStreamRequest({ base, apiKey, payload, timeout = PROBE_TIMEOUT_MS }) {
  const send = (body) => fetchStreamText(endpointUrl(base, "/chat/completions"), {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  }, timeout);
  try {
    return await send(payload);
  } catch (error) {
    const fallback = withoutTemperature(payload, error);
    if (!fallback) throw error;
    return send(fallback);
  }
}

async function responseJson(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Endpoint returned non-JSON (${response.status}).`);
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

function pickSafeHeaders(source) {
  const picked = {};
  for (const name of SAFE_HEADER_NAMES) {
    const value = typeof source?.get === "function" ? source.get(name) : source?.[name];
    const text = value == null ? "" : String(value).trim().slice(0, 200);
    if (text) picked[name] = text;
  }
  return picked;
}

function textFromCompletion(data) {
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function check(status, dimension, title, detail, weight, earned) {
  return { status, dimension, title, detail, weight, earned };
}

function pass(dimension, title, detail, weight) {
  return check("pass", dimension, title, detail, weight, weight);
}

function warn(dimension, title, detail, weight, earned = 0) {
  return check("warn", dimension, title, detail, weight, earned);
}

function fail(dimension, title, detail, weight) {
  return check("fail", dimension, title, detail, weight, 0);
}

function info(dimension, title, detail) {
  return check("info", dimension, title, detail, 0, 0);
}

function redact(message, secret) {
  const text = String(message ?? "");
  return secret ? text.split(secret).join("[redacted]") : text;
}

function redactDeep(value, secret) {
  if (!secret) return value;
  if (typeof value === "string") return redact(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secret)]));
  }
  return value;
}

function errorDetail(error, secret) {
  return error?.name === "AbortError" ? "The request timed out." : redact(error?.message || "Verification failed.", secret);
}

function errorFingerprint(error) {
  const message = String(error?.message || "").toLowerCase();
  if (error?.name === "AbortError" || /timed out|timeout/.test(message)) return "timeout";
  if (/unsupported parameter|unsupported value|not supported|unknown field|unrecognized|invalid parameter/.test(message)) return "unsupported_parameter";
  if (/context length|context window|too many tokens|maximum context/.test(message)) return "context_length";
  if (/rate limit|too many requests|429/.test(message)) return "rate_limit";
  if (/quota|insufficient|exceeded your current quota/.test(message)) return "quota";
  if (/invalid api key|unauthorized|401|403/.test(message)) return "auth";
  if (/not found|unknown model|does not exist|404/.test(message)) return "model_not_found";
  if (/http 5|internal server error|bad gateway|service unavailable|502|503|504/.test(message)) return "server_error";
  return "unknown";
}

function digitsOf(text) {
  return (String(text || "").match(/-?\d+/g) || []).map((value) => Number(value));
}

function firstUsefulNumber(text) {
  const values = digitsOf(text);
  const nonZero = values.find((value) => value !== 0);
  return nonZero ?? values[0] ?? null;
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageFrom(data) {
  return {
    promptTokens: tokenCount(data?.usage?.prompt_tokens),
    completionTokens: tokenCount(data?.usage?.completion_tokens),
    totalTokens: tokenCount(data?.usage?.total_tokens),
  };
}

async function runBaselineProbes({ base, apiKey, modelId }) {
  const payload = {
    model: modelId,
    temperature: 0,
    max_tokens: 24,
    messages: [
      { role: "system", content: "You are a verification probe. Follow the instruction exactly." },
      { role: "user", content: "Reply with exactly the word: verified" },
    ],
  };
  const runs = [];
  let firstCompletion = null;
  let firstError = null;

  for (let index = 1; index <= BASELINE_RUNS; index += 1) {
    const startedAt = Date.now();
    let safeHeaders = {};
    try {
      const data = await fetchWithRetry(() => chatJsonRequest({
        base,
        apiKey,
        payload,
        consume: (response) => {
          safeHeaders = Object.fromEntries(
            Object.entries(pickSafeHeaders(response.headers)).map(([name, value]) => [name, redact(value, apiKey)]),
          );
          return responseJson(response);
        },
      }));
      runs.push({
        index,
        returnedModel: String(data?.model || ""),
        family: familyFromModel(data?.model),
        latencyMs: Date.now() - startedAt,
        usage: usageFrom(data),
        systemFingerprint: typeof data?.system_fingerprint === "string" ? data.system_fingerprint : null,
        headers: safeHeaders,
        retries: data?.__retries || 0,
      });
      if (!firstCompletion) firstCompletion = data;
    } catch (error) {
      if (!firstError) firstError = error;
      runs.push({
        index,
        returnedModel: "",
        family: "Unknown family",
        latencyMs: Date.now() - startedAt,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
        systemFingerprint: null,
        headers: safeHeaders,
        error: errorDetail(error, apiKey),
      });
    }
  }

  return { runs, firstCompletion, firstError };
}

function parseSse(text) {
  const chunks = [];
  let done = false;
  let usage = null;
  let fullText = "";
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const data = JSON.parse(payload);
      if (data && data.usage) usage = data.usage;
      const delta = data?.choices?.[0]?.delta?.content || "";
      if (delta) {
        chunks.push(delta);
        fullText += delta;
      }
    } catch {}
  }
  return { chunks, done, usage, text: fullText };
}

async function runStreamProbe({ base, apiKey, modelId }) {
  const streamText = await chatStreamRequest({
    base,
    apiKey,
    payload: {
      model: modelId,
      temperature: 0,
      max_tokens: 24,
      stream: true,
      messages: [{ role: "user", content: "Count to three." }],
    },
  });
  return parseSse(streamText);
}

function assessRoutingStability(runs) {
  const successful = runs.filter((run) => !run.error);
  const known = successful.filter((run) => run.returnedModel);
  const failed = runs.length - successful.length;
  if (successful.length < 2) {
    return info("identity", "Routing stability", `Only ${successful.length} of ${runs.length} baseline probes completed, so routing stability could not be assessed.`);
  }
  if (!known.length) {
    return info("identity", "Routing stability", "No baseline probe returned a model identifier, so routing stability could not be assessed.");
  }

  const families = [...new Set(known.map((run) => run.family))];
  const models = [...new Set(known.map((run) => run.returnedModel))];
  if (families.length > 1) {
    return fail("identity", "Routing stability", `Baseline probes returned models from ${families.length} provider families: ${families.join(", ")}.`, 15);
  }
  if (models.length > 1) {
    return warn("identity", "Routing stability", `Baseline probes returned ${models.length} model IDs within ${families[0]}: ${models.join(", ")}.`, 15, 10);
  }
  const missing = successful.length - known.length;
  if (missing > 0) {
    return warn("identity", "Routing stability", `${missing} of ${runs.length} baseline probes omitted the model identifier, so routing could not be confirmed across all runs.`, 15, 5);
  }
  if (failed > 0) {
    return warn("identity", "Routing stability", `${failed} of ${runs.length} baseline probes failed. Routing could not be confirmed across all runs.`, 15, 5);
  }
  return pass("identity", "Routing stability", `All ${successful.length} baseline probes returned ${models[0]}.`, 15);
}

function assessUsageConsistency(runs) {
  const successful = runs.filter((run) => !run.error);
  const values = successful
    .map((run) => run.usage?.promptTokens)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length < 2) {
    return info("provenance", "Usage consistency", `Only ${values.length} successful baseline probes reported numeric prompt-token usage, so usage consistency could not be assessed.`);
  }
  if (values.length < successful.length) {
    return info("provenance", "Usage consistency", `Only ${values.length} of ${successful.length} successful baseline probes reported numeric prompt-token usage, so usage consistency could not be assessed.`);
  }
  if (values.every((value) => value === values[0])) {
    return values[0] > 0
      ? pass("provenance", "Usage consistency", `All ${values.length} successful baseline probes reported ${values[0]} prompt tokens.`, 10)
      : info("provenance", "Usage consistency", "All successful baseline probes reported zero prompt tokens, so usage consistency could not be assessed.");
  }
  return warn("provenance", "Usage consistency", `Successful baseline probes reported different prompt-token counts for the same prompt: ${values.join(", ")}.`, 10, 0);
}

function assessHeaderSignals(claimedFamily, headerFamily) {
  const known = (family) => family && family !== "Unknown family" && family !== "Mixed";
  if (headerFamily === "Mixed") {
    return known(claimedFamily)
      ? warn("provenance", "Header provenance", "Response headers contain signals for multiple provider families. Gateways can add or strip headers, so this signal is weak.", 5, 0)
      : info("provenance", "Header provenance", "Response headers contain signals for multiple provider families, but the claimed family is unknown.");
  }
  if (known(claimedFamily) && known(headerFamily) && claimedFamily === headerFamily) {
    return pass("provenance", "Header provenance", `Response headers identify the ${headerFamily} family, consistent with the claim.`, 5);
  }
  if (known(claimedFamily) && known(headerFamily)) {
    return warn("provenance", "Header provenance", `Response headers identify the ${headerFamily} family, which differs from the claimed ${claimedFamily} family. Gateways can add or strip headers, so this signal is weak.`, 5, 0);
  }
  return info("provenance", "Header provenance", "Header provenance is inconclusive because the claimed family or the header family is unknown.");
}

async function runModelVerification({ base, apiKey, modelId, advertisedIds = [], catalogEntry, catalogChecks = [], tokenBudget = MAX_PROBE_TOKENS_PER_RUN }) {
  const startedAt = new Date().toISOString();
  const claimedFamily = familyFromModel(modelId);
  const expected = advertisedCapabilities(modelId, catalogEntry);
  const checks = [];

  checks.push(advertisedIds.includes(modelId)
    ? pass("identity", "Catalog membership", "The requested model ID appears in the endpoint's advertised catalog.", 15)
    : warn("identity", "Catalog membership", "The requested model ID was not found in the endpoint's advertised catalog.", 15));
  checks.push(claimedFamily !== "Unknown family"
    ? pass("identity", "Claim attribution", `The requested ID maps to the ${claimedFamily} provider family.`, 10)
    : warn("identity", "Claim attribution", "The requested ID does not map to a recognized provider family, so provider identity cannot be attributed.", 10));

  const ownedBy = String(catalogEntry?.owned_by || "").trim();
  const ownerFamily = familyFromModel(ownedBy);
  if (ownedBy && claimedFamily !== "Unknown family" && ownerFamily !== "Unknown family") {
    checks.push(ownerFamily === claimedFamily
      ? pass("identity", "Catalog owner metadata", `The catalog reports ${ownedBy} as the owner, consistent with ${claimedFamily}. This metadata is self-reported.`, 5)
      : warn("identity", "Catalog owner metadata", `The catalog reports ${ownedBy} as the owner, which conflicts with the claimed ${claimedFamily} family. This metadata is self-reported.`, 5));
  }

  const baseline = await runBaselineProbes({ base, apiKey, modelId });
  const { runs, firstCompletion } = baseline;
  const successfulRuns = runs.filter((run) => !run.error);
  const headerFamily = familyFromHeaders(Object.assign({}, ...successfulRuns.map((run) => run.headers)));

  if (firstCompletion) {
    const returnedModel = String(firstCompletion.model || "");
    const returnedFamily = familyFromModel(returnedModel);
    if (!returnedModel) {
      checks.push(warn("identity", "Model routing", "The endpoint accepted the requested model but did not return a model identifier.", 20, 10));
    } else if (returnedModel === modelId) {
      checks.push(pass("identity", "Model routing", `Response identified itself as ${returnedModel}.`, 20));
    } else if (claimedFamily === "Unknown family") {
      checks.push(warn("identity", "Model routing", `Requested ${modelId}; the response identified itself as ${returnedModel}. The requested ID has no recognizable provider family, so routing cannot be confirmed.`, 20, 5));
    } else if (returnedFamily === claimedFamily) {
      checks.push(warn("identity", "Model routing", `Requested ${modelId}; the response identified itself as ${returnedModel}. This may be normal version routing within ${claimedFamily}, but it is not an exact match.`, 20, 12));
    } else if (returnedFamily !== "Unknown family") {
      checks.push(fail("identity", "Model routing", `Requested ${modelId} (${claimedFamily}), but the response identified itself as ${returnedModel} (${returnedFamily}).`, 20));
    } else {
      checks.push(warn("identity", "Model routing", `Requested ${modelId}; the response identified itself as ${returnedModel}, which could not be mapped to a provider family.`, 20, 5));
    }
  } else {
    checks.push(fail("identity", "Model routing", "No baseline chat probe completed, so routing could not be assessed.", 20));
  }

  checks.push(assessRoutingStability(runs));

  const returnedModel = firstCompletion?.model ? String(firstCompletion.model) : "";
  const returnedFamily = familyFromModel(returnedModel);
  if (ownedBy && returnedModel && ownerFamily !== "Unknown family" && returnedFamily !== "Unknown family" && ownerFamily !== returnedFamily) {
    checks.push(warn("identity", "Catalog model provenance", `The catalog owner (${ownedBy}, ${ownerFamily}) does not match the returned model (${returnedModel}, ${returnedFamily}). Aggregators can make this legitimate, so the signal is weak.`, 5, 2));
  }

  if (firstCompletion) {
    checks.push(firstCompletion?.choices?.[0]?.message
      ? pass("capability", "Chat completion", "The endpoint returned a valid chat-completion message.", 15)
      : warn("capability", "Chat completion", "The response did not contain a standard chat-completion message.", 15));
  } else {
    checks.push(fail("capability", "Chat completion", errorDetail(baseline.firstError, apiKey), 15));
  }

  checks.push(assessUsageConsistency(runs));

  let tokensUsed = BASELINE_RUNS * 24;
  const withinBudget = (cost) => {
    if (tokensUsed + cost > tokenBudget) return false;
    tokensUsed += cost;
    return true;
  };
  const budgetSkipped = (title) => info("capability", title, "Skipped so the run stays within its token budget.");

  if (firstCompletion && expected.likelyChat) {
    if (!withinBudget(16)) {
      checks.push(budgetSkipped("Known answer"));
    } else {
      try {
        const data = await chatJsonRequest({
          base,
          apiKey,
          payload: {
            model: modelId,
            temperature: 0,
            max_tokens: 16,
            messages: [
              { role: "system", content: "Reply with only the number." },
              { role: "user", content: "What is 17 plus 25?" },
            ],
          },
        });
        const answer = firstUsefulNumber(textFromCompletion(data));
        checks.push(answer === 42
          ? pass("capability", "Known answer", "The model returned the correct answer to a simple arithmetic probe.", 5)
          : warn("capability", "Known answer", "The model did not return the expected answer to a simple arithmetic probe.", 5, 2));
      } catch (error) {
        checks.push(info("capability", "Known answer", `The known-answer probe was inconclusive: ${errorDetail(error, apiKey)}`));
      }
    }
  }

  if (firstCompletion) {
    if (!withinBudget(120)) {
      checks.push(budgetSkipped("Structured output"));
    } else {
      try {
        const data = await chatJsonRequest({
          base,
          apiKey,
          payload: {
            model: modelId,
            temperature: 0,
            max_tokens: 120,
            messages: [
              { role: "system", content: "Return only valid JSON. Do not use markdown fences." },
              { role: "user", content: 'Return exactly this JSON shape with the value "ok": {"ok":true,"verifier":"model-endpoint-verifier"}' },
            ],
            response_format: { type: "json_object" },
          },
        });
        const json = parseJsonText(textFromCompletion(data));
        checks.push(json?.ok === true && json?.verifier === "model-endpoint-verifier"
          ? pass("capability", "Structured output", "The model returned the requested JSON object.", 20)
          : warn("capability", "Structured output", "The endpoint accepted the JSON-mode request but did not return the requested object.", 20, 5));
      } catch (error) {
        const fp = errorFingerprint(error);
        const detail = fp === "unsupported_parameter"
          ? `The endpoint rejected the JSON-mode request: ${errorDetail(error, apiKey)}`
          : fp === "rate_limit" || fp === "quota" || fp === "auth"
            ? `The structured-output probe could not be assessed (${fp}): ${errorDetail(error, apiKey)}`
            : `The structured-output probe was inconclusive: ${errorDetail(error, apiKey)}`;
        checks.push(warn("capability", "Structured output", detail, 20));
      }
    }
  }

  if (firstCompletion && expected.likelyTools) {
    if (!withinBudget(80)) {
      checks.push(budgetSkipped("Tool calling"));
    } else {
      try {
        const toolCall = await chatJsonRequest({
          base,
          apiKey,
          payload: {
            model: modelId,
            temperature: 0,
            max_tokens: 80,
            messages: [{ role: "user", content: "Use the available tool to look up the weather in London." }],
            tools: [{ type: "function", function: { name: "get_weather", description: "Get current weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
            tool_choice: { type: "function", function: { name: "get_weather" } },
          },
        });
        const calls = toolCall?.choices?.[0]?.message?.tool_calls;
        checks.push(Array.isArray(calls) && calls.length > 0
          ? pass("capability", "Tool calling", "The model produced a tool-call envelope matching the API format.", 15)
          : warn("capability", "Tool calling", "The endpoint accepted the tool request but did not emit a tool call.", 15, 5));
      } catch (error) {
        const fp = errorFingerprint(error);
        const detail = fp === "unsupported_parameter"
          ? `The endpoint rejected the tool-call request: ${errorDetail(error, apiKey)}`
          : fp === "rate_limit" || fp === "quota" || fp === "auth"
            ? `The tool-call probe could not be assessed (${fp}): ${errorDetail(error, apiKey)}`
            : `The advertised chat model did not pass the tool-call probe: ${errorDetail(error, apiKey)}`;
        checks.push(warn("capability", "Tool calling", detail, 15));
      }
    }
  }

  if (firstCompletion && expected.likelyChat) {
    if (!withinBudget(24)) {
      checks.push(budgetSkipped("Streaming"));
    } else {
      try {
        const stream = await runStreamProbe({ base, apiKey, modelId });
        checks.push(stream.done && stream.text.length > 0
          ? pass("capability", "Streaming", `Streamed ${stream.chunks.length} chunks and reached [DONE].`, 10)
          : warn("capability", "Streaming", "The stream did not complete or produced no text.", 10, 0));
      } catch (error) {
        checks.push(warn("capability", "Streaming", `The streaming probe failed: ${errorDetail(error, apiKey)}`, 10));
      }
    }
  }

  checks.push(assessHeaderSignals(claimedFamily, headerFamily));

  checks.push(...catalogChecks);

  const totalWeight = checks.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  const totalEarned = checks.reduce((sum, item) => sum + item.earned, 0);
  const score = totalWeight > 0 ? Math.round((totalEarned / totalWeight) * 100) : 0;
  const failures = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warn").length;
  const verdict = failures > 0 ? "Inconsistent / suspicious" : score >= 70 && warnings === 0 ? "Behaviorally consistent" : score >= 45 ? "Partially consistent" : "Unable to verify";

  return {
    id: randomUUID(),
    model: modelId,
    claimedFamily,
    verdict,
    score,
    startedAt,
    durationMs: Date.now() - new Date(startedAt).getTime(),
    checks,
    observations: { runs, headerFamily },
    limitation: "Black-box behavior cannot prove the underlying model identity without provider-signed attestation. The score reflects available weighted evidence; info checks mean a signal could not be assessed.",
  };
}

function sameIdSet(first, second) {
  if (first.length !== second.length) return false;
  return first.every((id) => second.includes(id));
}

function catalogMetadata(model) {
  const contextLength = [model.context_length, model.context_window, model.max_context_length, model.max_model_len]
    .find((value) => typeof value === "number" && Number.isFinite(value)) ?? null;
  const inputModalities = Array.isArray(model.architecture?.input_modalities)
    ? model.architecture.input_modalities
    : Array.isArray(model.input_modalities) ? model.input_modalities : null;
  const outputModalities = Array.isArray(model.architecture?.output_modalities)
    ? model.architecture.output_modalities
    : Array.isArray(model.output_modalities) ? model.output_modalities : null;
  return { contextLength, inputModalities, outputModalities };
}

async function discoverCatalog(base, apiKey) {
  const first = await fetchJsonWithTimeout(endpointUrl(base, "/models"), {
    headers: headers(apiKey),
  });
  await new Promise((resolve) => setTimeout(resolve, CATALOG_RECHECK_DELAY_MS));
  let second;
  let stable = true;
  try {
    second = await fetchJsonWithTimeout(endpointUrl(base, "/models"), {
      headers: headers(apiKey),
    });
  } catch {
    stable = false;
    second = null;
  }
  const parse = (catalog) =>
    (Array.isArray(catalog?.data) ? catalog.data : [])
      .filter((model) => model && typeof model === "object")
      .map((model) => ({ id: String(model.id || "").trim(), owned_by: model.owned_by, created: model.created, ...catalogMetadata(model) }))
      .filter((model) => model.id);
  const models = parse(first);
  const secondModels = second ? parse(second) : null;
  const firstIds = models.map((model) => model.id);
  const secondIds = secondModels ? secondModels.map((model) => model.id) : null;
  if (secondIds && !sameIdSet(firstIds, secondIds)) stable = false;
  return { models, stable };
}

function dedupeById(models) {
  const seen = new Set();
  const deduped = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    deduped.push(model);
  }
  return deduped;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const current = next;
      next += 1;
      results[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function catalogChecks(models, stable) {
  const checks = [];
  const seen = new Set();
  let hasDuplicates = false;
  for (const model of models) {
    if (seen.has(model.id)) {
      hasDuplicates = true;
      break;
    }
    seen.add(model.id);
  }
  checks.push(
    hasDuplicates
      ? warn("identity", "Duplicate model IDs", "The catalog lists the same model ID more than once, so selection may be ambiguous.", 5)
      : pass("identity", "Duplicate model IDs", "No duplicate model IDs in the advertised catalog.", 5),
  );
  checks.push(
    !stable
      ? warn("identity", "Catalog stability", "The advertised catalog changed between discovery requests, so model selection may not be stable.", 5)
      : pass("identity", "Catalog stability", "The advertised catalog was stable across discovery requests.", 5),
  );
  return checks;
}

async function verify(body) {
  const base = normalizeEndpoint(body.endpoint);
  const apiKey = String(body.apiKey || "").trim();
  if (!apiKey) throw new Error("Enter an API key.");
  const requestedModel = String(body.model || "").trim();
  await assertNotPrivateTarget(base);
  const { models: rawModels, stable } = await discoverCatalog(base, apiKey);
  const models = dedupeById(rawModels);
  if (!models.length) throw new Error("The endpoint responded, but its /models response did not contain any usable model IDs.");
  const availableIds = models.map((model) => model.id);
  const budgeted = requestedModel ? [requestedModel] : availableIds.slice(0, MAX_MODELS_PER_RUN);
  const tokenBudget = Math.max(1, Math.floor(MAX_PROBE_TOKENS_PER_RUN / Math.max(1, budgeted.length)));
  const catChecks = catalogChecks(rawModels, stable);
  const reports = await mapWithConcurrency(budgeted, MODEL_CONCURRENCY, async (modelId) => {
    const catalogEntry = models.find((model) => model.id === modelId);
    return runModelVerification({ base, apiKey, modelId, advertisedIds: availableIds, catalogEntry, catalogChecks: catChecks, tokenBudget });
  });
  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: base,
    catalogCount: availableIds.length,
    catalog: models.slice(0, 100).map((model) => ({
      id: model.id,
      ownedBy: model.owned_by,
      created: model.created,
      contextLength: model.contextLength,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
    })),
    selectedModels: reports,
    note: "API key was used in memory for this request and is not included in the returned report.",
  };
  return redactDeep(report, apiKey);
}

async function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir + sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(content);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/verify") {
      const result = await verify(await readBody(req));
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 400, { error: error.name === "AbortError" ? "The endpoint timed out." : error.message || "Verification failed." });
  }
});

const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Model Endpoint Verifier running at http://${host}:${port}`);
});
