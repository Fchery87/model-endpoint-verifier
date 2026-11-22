import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];
const key = `test-key-${process.pid}-${Date.now()}`;

async function freePorts(count) {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    })),
  );
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function start(script, env = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitFor(url, init = {}, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChildren() {
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  })));
}

let mockBase;
let verifierBase;
let stallVerifierBase;
let budgetVerifierBase;
let ssrfVerifierBase;

try {
  const [mockPort, verifierPort, stallVerifierPort, budgetVerifierPort, ssrfVerifierPort] = await freePorts(5);
  mockBase = `http://127.0.0.1:${mockPort}`;
  verifierBase = `http://127.0.0.1:${verifierPort}`;
  stallVerifierBase = `http://127.0.0.1:${stallVerifierPort}`;
  budgetVerifierBase = `http://127.0.0.1:${budgetVerifierPort}`;
  ssrfVerifierBase = `http://127.0.0.1:${ssrfVerifierPort}`;

  start("test/mock-provider.mjs", { MOCK_PORT: String(mockPort), MOCK_KEY: key });
  start("server.js", { PORT: String(verifierPort) });
  start("server.js", { PORT: String(stallVerifierPort), PROBE_TIMEOUT_MS: "800" });
  start("server.js", { PORT: String(budgetVerifierPort), MAX_PROBE_TOKENS_PER_RUN: "100" });
  start("server.js", { PORT: String(ssrfVerifierPort), HOSTED_SSRF_GUARD: "1" });
  await waitFor(`${mockBase}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  await waitFor(`${verifierBase}/`);
  await waitFor(`${stallVerifierBase}/`);
  await waitFor(`${budgetVerifierBase}/`);
  await waitFor(`${ssrfVerifierBase}/`);

  const page = await fetch(`${verifierBase}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Model Endpoint Verifier|SIGNAL/);

  const styles = await fetch(`${verifierBase}/styles.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type"), /text\/css/);
  const stylesText = await styles.text();
  for (const className of ["empty-state", "loading-state"]) {
    const rules = stylesText.match(new RegExp(`\\.${className}[^\\{]*\\{[^}]*display[^}]*\\}`, "g")) || [];
    assert.ok(rules.length > 0, `Expected a display rule for .${className} in styles.css`);
    assert.ok(rules.every((rule) => rule.includes(":not([hidden])")), `.${className} display rules must not override the hidden attribute`);
  }

  const script = await fetch(`${verifierBase}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const traversal = await fetch(`${verifierBase}/%2e%2e/server.js`);
  assert.ok([403, 404].includes(traversal.status), "Path traversal must not serve server.js");

  async function verifyModel(model, endpoint = `${mockBase}/v1`) {
    const response = await fetch(`${verifierBase}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint, apiKey: key, model }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  function checkFor(report, title) {
    return report.checks.find((item) => item.title === title);
  }

  const report = await verifyModel("claude-sonnet-4");
  assert.equal(report.catalogCount, 16);
  assert.equal(report.selectedModels.length, 1);
  const claudeCatalog = report.catalog.find((model) => model.id === "claude-sonnet-4");
  assert.equal(claudeCatalog.contextLength, 200000);
  assert.deepEqual(claudeCatalog.inputModalities, ["text", "image"]);
  assert.deepEqual(claudeCatalog.outputModalities, ["text"]);

  const claude = report.selectedModels[0];
  assert.equal(claude.model, "claude-sonnet-4");
  assert.equal(claude.verdict, "Behaviorally consistent");
  assert.equal(claude.observations.runs.length, 3);
  assert.deepEqual(claude.observations.runs.map((run) => run.returnedModel), ["claude-sonnet-4", "claude-sonnet-4", "claude-sonnet-4"]);
  assert.equal(claude.observations.headerFamily, "Anthropic");
  assert.ok(claude.observations.runs.every((run) => run.headers["x-request-id"]));
  assert.ok(claude.observations.runs.every((run) => run.headers["x-request-id"].length === 200));
  assert.ok(claude.observations.runs.every((run) => run.headers.server === "mock-provider"));
  assert.equal(checkFor(claude, "Routing stability").status, "pass");
  assert.equal(checkFor(claude, "Usage consistency").status, "pass");
  assert.equal(checkFor(claude, "Usage consistency").dimension, "provenance");
  assert.equal(checkFor(claude, "Tool calling").status, "pass");
  assert.equal(checkFor(claude, "Structured output").status, "pass");
  assert.equal(checkFor(claude, "Known answer").status, "pass");

  const substitutedReport = await verifyModel("deepseek-chat");
  const substituted = substitutedReport.selectedModels[0];
  assert.equal(substituted.verdict, "Inconsistent / suspicious");
  assert.equal(checkFor(substituted, "Model routing").status, "fail");
  assert.equal(substituted.observations.headerFamily, "OpenAI");
  const provenance = checkFor(substituted, "Header provenance");
  assert.equal(provenance.status, "warn");
  assert.match(provenance.detail, /weak/);
  const ownerProvenance = checkFor(substituted, "Catalog model provenance");
  assert.equal(ownerProvenance.status, "warn");
  assert.match(ownerProvenance.detail, /deepseek.*does not match|does not match.*gpt-4o-mini/);

  const flakyReport = await verifyModel("flaky-router");
  const flaky = flakyReport.selectedModels[0];
  assert.equal(flaky.verdict, "Inconsistent / suspicious");
  assert.equal(checkFor(flaky, "Routing stability").status, "fail");
  assert.equal(new Set(flaky.observations.runs.map((run) => run.family)).size, 2);

  const miniReport = await verifyModel("gpt-4o-mini");
  const mini = miniReport.selectedModels[0];
  assert.equal(mini.verdict, "Partially consistent");
  assert.equal(checkFor(mini, "Usage consistency").status, "warn");
  assert.deepEqual(mini.observations.runs.map((run) => run.usage.promptTokens), [20, 21, 22]);

  const silentReport = await verifyModel("silent-metadata");
  const silent = silentReport.selectedModels[0];
  assert.equal(silent.verdict, "Partially consistent");
  assert.equal(silent.claimedFamily, "Unknown family");
  assert.equal(checkFor(silent, "Claim attribution").status, "warn");
  assert.equal(checkFor(silent, "Model routing").status, "warn");
  assert.equal(checkFor(silent, "Routing stability").status, "info");
  assert.equal(checkFor(silent, "Usage consistency").status, "info");
  assert.equal(silent.observations.runs.length, 3);
  assert.ok(silent.observations.runs.every((run) => !run.returnedModel));

  const geminiReport = await verifyModel("gemini-2.0-flash");
  const gemini = geminiReport.selectedModels[0];
  assert.equal(gemini.verdict, "Partially consistent");
  assert.equal(gemini.observations.headerFamily, "Mixed");
  assert.equal(checkFor(gemini, "Header provenance").status, "warn");

  const leakyReport = await verifyModel("leaky-model");
  const leaky = leakyReport.selectedModels[0];
  assert.ok(!JSON.stringify(leakyReport).includes(key), "Provider-echoed key must be redacted from the whole report");
  assert.equal(leaky.observations.runs[0].returnedModel, "[redacted]");
  assert.equal(leakyReport.catalog.find((model) => model.id === "leaky-model").ownedBy, "[redacted]");

  const aliasReport = await verifyModel("sneaky-alias");
  const alias = aliasReport.selectedModels[0];
  assert.equal(alias.verdict, "Partially consistent");
  assert.equal(checkFor(alias, "Claim attribution").status, "warn");

  const noJsonReport = (await verifyModel("gpt-3.5-turbo")).selectedModels[0];
  assert.equal(noJsonReport.verdict, "Partially consistent");
  assert.equal(checkFor(noJsonReport, "Structured output").status, "warn");
  assert.ok(!noJsonReport.checks.some((item) => item.title === "Chat completion" && item.status === "fail"));

  const retryReport = await verifyModel("retry-gpt-4o");
  const retry = retryReport.selectedModels[0];
  assert.equal(retry.verdict, "Behaviorally consistent");
  assert.equal(checkFor(retry, "Routing stability").status, "pass");
  assert.equal(retry.observations.runs.length, 3);
  assert.ok(retry.observations.runs.every((run) => !run.error));
  assert.equal(retry.observations.runs[0].retries, 1, "The retried baseline run must record its retry");
  assert.equal(retry.observations.runs[1].retries, 0);

  const streamReport = await verifyModel("claude-sonnet-4");
  assert.equal(checkFor(streamReport.selectedModels[0], "Streaming").status, "pass");

  const modernFamilies = [
    ["claude-opus-5-5", "Anthropic"],
    ["gpt-6.2-astra", "OpenAI"],
    ["gemini-4-carbon", "Google"],
    ["deepseek-v4.1-flash", "DeepSeek"],
  ];
  for (const [model, family] of modernFamilies) {
    const modern = (await verifyModel(model)).selectedModels[0];
    assert.equal(modern.claimedFamily, family, `${model} must map to ${family}`);
  }

  const reasoningReport = await verifyModel("gpt-6-reasoning");
  const reasoning = reasoningReport.selectedModels[0];
  assert.equal(reasoning.verdict, "Behaviorally consistent");
  assert.equal(checkFor(reasoning, "Chat completion").status, "pass");
  assert.equal(checkFor(reasoning, "Structured output").status, "pass");
  assert.equal(checkFor(reasoning, "Streaming").status, "pass");

  const dupReport = (await verifyModel("gpt-4o", `${mockBase}/v1/dup`)).selectedModels[0];
  assert.equal(checkFor(dupReport, "Duplicate model IDs").status, "warn");

  const unstableReport = (await verifyModel("gpt-4o", `${mockBase}/v1/unstable`)).selectedModels[0];
  assert.equal(checkFor(unstableReport, "Catalog stability").status, "warn");
  assert.equal(checkFor(unstableReport, "Duplicate model IDs").status, "pass");

  const versionedReport = await verifyModel("gpt-4o", `${mockBase}/v1beta/openai/chat/completions`);
  assert.equal(versionedReport.selectedModels[0].verdict, "Behaviorally consistent");

  const defaultResponse = await fetch(`${verifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/v1`, apiKey: key }),
  });
  assert.equal(defaultResponse.status, 200);
  const defaultReport = await defaultResponse.json();
  assert.equal(defaultReport.selectedModels.length, 5);
  assert.deepEqual(
    defaultReport.selectedModels.map((item) => item.model),
    ["claude-sonnet-4", "gpt-4o", "deepseek-chat", "gpt-3.5-turbo", "sneaky-alias"],
  );

  const stallStarted = Date.now();
  const stallResponse = await fetch(`${stallVerifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/stall/v1`, apiKey: key, model: "gpt-4o" }),
  });
  const stallReport = await stallResponse.json();
  const stall = stallReport.selectedModels[0];
  assert.equal(stallResponse.status, 200);
  assert.ok(Date.now() - stallStarted < 5_000, "A stalled response body must abort within the probe timeout");
  assert.equal(stall.verdict, "Inconsistent / suspicious");
  assert.equal(checkFor(stall, "Chat completion").status, "fail");
  assert.equal(checkFor(stall, "Chat completion").detail, "The request timed out.");
  assert.equal(stall.observations.runs.length, 3);
  assert.ok(stall.observations.runs.every((run) => run.error === "The request timed out."));

  const budgetResponse = await fetch(`${budgetVerifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/v1`, apiKey: key, model: "claude-sonnet-4" }),
  });
  assert.equal(budgetResponse.status, 200);
  const budgetReport = await budgetResponse.json();
  const budgeted = budgetReport.selectedModels[0];
  assert.equal(checkFor(budgeted, "Known answer").status, "pass", "Cheap probes must still run inside a tight token budget");
  assert.equal(checkFor(budgeted, "Structured output").status, "info");
  assert.match(checkFor(budgeted, "Structured output").detail, /token budget/);
  assert.equal(checkFor(budgeted, "Tool calling").status, "info");
  assert.equal(checkFor(budgeted, "Streaming").status, "info");

  const ssrfResponse = await fetch(`${ssrfVerifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/v1`, apiKey: key, model: "gpt-4o" }),
  });
  assert.equal(ssrfResponse.status, 400);
  assert.match((await ssrfResponse.json()).error, /loopback/, "The hosted SSRF guard must reject loopback targets");

  const allReports = [report, substitutedReport, flakyReport, miniReport, silentReport, geminiReport, leakyReport, aliasReport, noJsonReport, retryReport, streamReport, dupReport, unstableReport, reasoningReport, versionedReport, defaultReport, stallReport, budgetReport];
  for (const item of allReports) {
    const raw = JSON.stringify(item);
    assert.ok(!raw.includes(key), "API key must not appear in the report");
    assert.ok(!raw.toLowerCase().includes("authorization"), "Authorization header must not appear in the report");
    assert.ok(!raw.toLowerCase().includes("cookie"), "Cookie headers must not appear in the report");
  }

  const emptyCatalog = await fetch(`${verifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/empty/v1`, apiKey: key, model: "gpt-4o" }),
  });
  assert.equal(emptyCatalog.status, 400);
  assert.match((await emptyCatalog.json()).error, /usable model IDs/);

  const insecure = await fetch(`${verifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://example.com/v1", apiKey: key, model: "gpt-4o" }),
  });
  assert.equal(insecure.status, 400);
  assert.match((await insecure.json()).error, /HTTPS/);

  const unauthorized = await fetch(`${verifierBase}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: `${mockBase}/v1`, apiKey: "wrong", model: "gpt-4o" }),
  });
  assert.equal(unauthorized.status, 400);
  const unauthorizedBody = await unauthorized.json();
  assert.match(unauthorizedBody.error, /Invalid API key/);
  assert.ok(!JSON.stringify(unauthorizedBody).includes("wrong"), "Rejected key must be masked");

  console.log("smoke test passed");
} finally {
  await stopChildren();
}
