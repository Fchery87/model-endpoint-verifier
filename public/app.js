const form = document.querySelector("#verify-form");
const button = document.querySelector("#run-button");
const errorBox = document.querySelector("#form-error");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const loadingCopy = document.querySelector("#loading-copy");
const report = document.querySelector("#report");
const reportTime = document.querySelector("#report-time");
const downloadButton = document.querySelector("#download-report");
let lastReport = null;

const CHECK_ICONS = { pass: "✓", warn: "~", fail: "!", info: "i" };

downloadButton.addEventListener("click", () => {
  if (!lastReport) return;
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `model-verification-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#toggle-key").addEventListener("click", (event) => {
  const input = document.querySelector("#apiKey");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  event.currentTarget.textContent = visible ? "SHOW" : "HIDE";
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
}

function renderCheck(check) {
  return `<div class="check ${escapeHtml(check.status)}"><div class="check-icon">${CHECK_ICONS[check.status] || "i"}</div><div><div class="check-title">${escapeHtml(check.title)}<span class="check-dimension">${escapeHtml(check.dimension)}</span></div><div class="check-detail">${escapeHtml(check.detail)}</div></div></div>`;
}

function renderRun(run) {
  const headers = Object.entries(run.headers || {});
  const promptTokens = run.usage?.promptTokens == null ? "n/a" : String(run.usage.promptTokens);
  return `
    <div class="run">
      <div class="run-head"><span>RUN ${escapeHtml(run.index)}</span><span>${escapeHtml(run.returnedModel || "NO MODEL ID")}</span></div>
      <div class="run-meta">
        <span><b>LATENCY</b> ${escapeHtml(run.latencyMs)} ms</span>
        <span><b>PROMPT TOKENS</b> ${escapeHtml(promptTokens)}</span>
        <span><b>RETRIES</b> ${escapeHtml(run.retries || 0)}</span>
        <span><b>SYSTEM FINGERPRINT</b> ${run.systemFingerprint ? escapeHtml(run.systemFingerprint) : "n/a"}</span>
      </div>
      ${run.error ? `<div class="run-error">${escapeHtml(run.error)}</div>` : ""}
      <div class="run-headers"><span class="run-headers-label">HEADERS</span>${headers.length ? `<ul>${headers.map(([name, value]) => `<li><span>${escapeHtml(name)}</span> ${escapeHtml(value)}</li>`).join("")}</ul>` : "<p>No safe headers captured.</p>"}</div>
    </div>`;
}

function renderObservations(observations) {
  const runs = observations?.runs || [];
  if (!runs.length) return "";
  return `<details class="observations"><summary>RAW ROUTING OBSERVATIONS · ${runs.length} RUNS · HEADER FAMILY ${escapeHtml(observations.headerFamily || "UNKNOWN")}</summary><div class="run-list">${runs.map(renderRun).join("")}</div></details>`;
}

function renderReport(data) {
  const tested = data.selectedModels || [];
  if (!tested.length) return;
  lastReport = data;
  downloadButton.hidden = false;
  const average = Math.round(tested.reduce((sum, item) => sum + item.score, 0) / tested.length);
  const failures = tested.some((item) => item.verdict.includes("Inconsistent"));
  const unverifiable = tested.some((item) => item.verdict.includes("Unable"));
  const warnings = tested.some((item) => item.verdict.includes("Partially"));
  const overall = failures ? "Inconsistent / suspicious" : unverifiable ? "Unable to verify" : warnings ? "Partially consistent" : "Behaviorally consistent";
  const verdictClass = failures ? "bad" : unverifiable ? "warn" : warnings ? "warn" : "good";
  const cards = tested.map((item) => `
    <article class="model-card">
      <div class="report-summary">
        <div class="report-kicker">MODEL CLAIM / ${escapeHtml(item.claimedFamily.toUpperCase())}</div>
        <div class="report-model">${escapeHtml(item.model)}</div>
        <div class="score-row"><div><div class="score-label">WEIGHTED CONSISTENCY</div><div class="score">${item.score}<small>/100</small></div></div><div class="verdict ${item.verdict.includes("Inconsistent") ? "bad" : item.verdict.includes("Partially") || item.verdict.includes("Unable") ? "warn" : "good"}">${escapeHtml(item.verdict)}</div></div>
      </div>
      <div class="checks">${item.checks.map(renderCheck).join("")}</div>
      ${renderObservations(item.observations)}
      <div class="report-meta"><span>${escapeHtml(String(item.durationMs))} ms probe</span><span>${escapeHtml(item.startedAt.replace("T", " ").replace("Z", " UTC"))}</span></div>
    </article>`).join("");
  const catalog = data.catalog.filter((model) => model.id);
  const catalogItem = (model) => {
    const extras = [
      model.ownedBy,
      model.contextLength ? `${model.contextLength} ctx` : null,
      Array.isArray(model.inputModalities) ? model.inputModalities.join("/") : null,
    ].filter(Boolean);
    return `<li>${escapeHtml(model.id)}${extras.length ? ` <span>· ${extras.map(escapeHtml).join(" · ")}</span>` : ""}</li>`;
  };
  report.innerHTML = `<div class="report-summary"><div class="report-kicker">VERIFICATION COMPLETE / ${data.selectedModels.length} MODEL${data.selectedModels.length === 1 ? "" : "S"} TESTED</div><div class="score-row"><div><div class="score-label">AVG CONSISTENCY</div><div class="score">${average}<small>/100</small></div></div><div class="verdict ${verdictClass}">${overall}</div></div></div><div class="report-limit">${escapeHtml(data.note)}<br />${escapeHtml(tested[0].limitation)}</div>${cards}<details class="catalog"><summary>ADVERTISED CATALOG · ${data.catalogCount} MODELS${data.catalogCount > catalog.length ? " (FIRST 100 SHOWN)" : ""}</summary><ul class="catalog-list">${catalog.map(catalogItem).join("")}</ul></details>`;
  emptyState.hidden = true;
  loadingState.hidden = true;
  report.hidden = false;
  reportTime.textContent = new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  report.hidden = true;
  lastReport = null;
  downloadButton.hidden = true;
  emptyState.hidden = true;
  loadingState.hidden = false;
  button.disabled = true;
  button.querySelector("span").textContent = "RUNNING PROBES";
  reportTime.textContent = "IN PROGRESS";
  const phases = ["Connecting to the model catalog", "Checking advertised model IDs", "Running behavioral probes", "Compiling evidence report"];
  let phase = 0;
  const phaseTimer = setInterval(() => { loadingCopy.textContent = phases[Math.min(++phase, phases.length - 1)]; }, 1200);
  try {
    const response = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Verification failed.");
    renderReport(data);
  } catch (error) {
    loadingState.hidden = true;
    emptyState.hidden = false;
    reportTime.textContent = "ERROR";
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    clearInterval(phaseTimer);
    button.disabled = false;
    button.querySelector("span").textContent = "RUN VERIFICATION";
  }
});
