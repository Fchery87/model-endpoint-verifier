import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT);
const key = process.env.MOCK_KEY || "test-secret-key";
if (!port) throw new Error("MOCK_PORT is required.");
const models = [
  { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: 1735689600, context_length: 200000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "gpt-4o", object: "model", owned_by: "openai", created: 1735689600 },
  { id: "deepseek-chat", object: "model", owned_by: "deepseek", created: 1735689600 },
  { id: "gpt-3.5-turbo", object: "model", owned_by: "openai", created: 1735689600 },
  { id: "sneaky-alias", object: "model", owned_by: "aggregator", created: 1735689600 },
  { id: "flaky-router", object: "model", owned_by: "aggregator", created: 1735689600 },
  { id: "gpt-4o-mini", object: "model", owned_by: "openai", created: 1735689600 },
  { id: "silent-metadata", object: "model", owned_by: "aggregator", created: 1735689600 },
  { id: "gemini-2.0-flash", object: "model", owned_by: "google", created: 1735689600 },
  { id: "leaky-model", object: "model", owned_by: key, created: 1735689600 },
  { id: "retry-gpt-4o", object: "model", owned_by: "aggregator", created: 1735689600 },
  { id: "claude-opus-5-5", object: "model", owned_by: "anthropic", created: 1762732800, context_length: 1000000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "gpt-6.2-astra", object: "model", owned_by: "openai", created: 1763337600, context_length: 1050000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "gemini-4-carbon", object: "model", owned_by: "google", created: 1762732800, context_length: 1000000, architecture: { input_modalities: ["text", "image", "audio"], output_modalities: ["text"] } },
  { id: "deepseek-v4.1-flash", object: "model", owned_by: "deepseek", created: 1760659200, context_length: 1000000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
  { id: "gpt-6-reasoning", object: "model", owned_by: "openai", created: 1763337600 },
];

let requestCount = 0;
let flakyBaselineCount = 0;
let miniBaselineCount = 0;
let retryBaselineCount = 0;
let unstableToggle = 0;

function responseHeaders(servedModel) {
  requestCount += 1;
  const headers = {
    "content-type": "application/json",
    server: "mock-provider",
    "x-request-id": `mock-request-${requestCount}-${"x".repeat(220)}`,
    authorization: `Bearer ${key}`,
    cookie: "session=should-not-appear",
    "set-cookie": "session=should-not-appear",
  };
  if (String(servedModel || "").startsWith("claude")) {
    headers["anthropic-request-id"] = `req_${requestCount}`;
    headers["anthropic-ratelimit-requests-limit"] = "100";
  } else if (String(servedModel || "").startsWith("gpt")) {
    headers["openai-version"] = "2024-01-01";
    headers["openai-processing-ms"] = "12";
  }
  if (String(servedModel || "").startsWith("gemini")) {
    headers["anthropic-request-id"] = `req_${requestCount}`;
    headers["openai-version"] = "2024-01-01";
  }
  return headers;
}

function send(res, status, body, servedModel) {
  res.writeHead(status, responseHeaders(servedModel));
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${key}`;
}

createServer((req, res) => {
  if (!authorized(req)) return send(res, 401, { error: { message: "Invalid API key." } });
  const path = req.url.replace(/^\/v1beta\/openai/, "/v1");

  if (req.method === "GET" && path === "/empty/v1/models") {
    return send(res, 200, { object: "list", data: [{ id: "" }, null] });
  }

  if (req.method === "GET" && path === "/v1/dup/models") {
    return send(res, 200, { object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o" }] });
  }

  if (req.method === "GET" && path === "/v1/unstable/models") {
    const ids = unstableToggle % 2 === 0 ? ["gpt-4o", "claude-sonnet-4"] : ["gpt-4o"];
    unstableToggle += 1;
    return send(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "aggregator", created: 1735689600 })) });
  }

  if (req.method === "GET" && path === "/stall/v1/models") {
    return send(res, 200, { object: "list", data: models.slice(0, 1) });
  }

  if (req.method === "POST" && path === "/stall/v1/chat/completions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"id":"stall",');
    return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    return send(res, 200, { object: "list", data: models });
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      const requested = payload.model;
      const isToolCall = Array.isArray(payload.tools) && payload.tools.length > 0;
      const isBaseline = !payload.response_format && !isToolCall && payload.stream !== true;
      if (requested === "gpt-6-reasoning" && "temperature" in payload) {
        return send(res, 400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }, requested);
      }
      if (payload.stream === true) {
        const served = requested === "deepseek-chat" ? "gpt-4o-mini" : requested;
        const hdrs = responseHeaders(served);
        hdrs["content-type"] = "text/event-stream";
        res.writeHead(200, hdrs);
        const chunk1 = { id: "chatcmpl-stream", object: "chat.completion.chunk", model: served, choices: [{ index: 0, delta: { role: "assistant", content: "One" } }] };
        const chunk2 = { id: "chatcmpl-stream", object: "chat.completion.chunk", model: served, choices: [{ index: 0, delta: { content: " two" } }] };
        const chunk3 = { id: "chatcmpl-stream", object: "chat.completion.chunk", model: served, choices: [{ index: 0, delta: { content: " three" } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (payload.response_format && requested === "gpt-3.5-turbo") {
        return send(res, 400, { error: { message: "response_format is not supported for this model." } }, requested);
      }

      let served = requested === "deepseek-chat" ? "gpt-4o-mini" : requested;
      if (requested === "leaky-model") served = key;
      if (requested === "flaky-router") {
        if (isBaseline) {
          served = flakyBaselineCount % 2 === 0 ? "claude-sonnet-4" : "gpt-4o";
          flakyBaselineCount += 1;
        } else {
          served = "claude-sonnet-4";
        }
      }
      if (requested === "retry-gpt-4o" && isBaseline) {
        retryBaselineCount += 1;
        if (retryBaselineCount === 1) {
          return send(res, 500, { error: { message: "Transient failure." } }, requested);
        }
      }

      let promptTokens = 20;
      if (requested === "gpt-4o-mini" && isBaseline) {
        promptTokens = 20 + (miniBaselineCount % 3);
        miniBaselineCount += 1;
      }
      const usage = { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 };

      if (isToolCall) {
        return send(res, 200, {
          id: "chatcmpl-mock-tool",
          object: "chat.completion",
          model: served,
          system_fingerprint: "fp_mock_7",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_mock_1",
                type: "function",
                function: { name: "get_weather", arguments: "{\"city\":\"London\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage,
        }, served);
      }

      const content = payload.response_format?.type === "json_object"
        ? JSON.stringify({ ok: true, verifier: "model-endpoint-verifier" })
        : "Hello from the mock provider.";
      const includeMetadata = !(requested === "silent-metadata" && isBaseline);
      const responseBody = {
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      };
      if (includeMetadata) {
        responseBody.model = served;
        responseBody.system_fingerprint = "fp_mock_7";
        responseBody.usage = usage;
      }
      return send(res, 200, responseBody, served);
    });
    return;
  }

  send(res, 404, { error: { message: "Not found." } });
}).listen(port, "127.0.0.1", () => console.log(`mock provider on ${port}`));
