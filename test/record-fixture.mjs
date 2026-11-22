// Records a sanitized verification report against a live endpoint.
//
// Usage:
//   LIVE_ENDPOINT=https://api.example.com/v1 LIVE_API_KEY=sk-... \
//   [LIVE_MODEL=gpt-4o] [LIVE_LABEL=my-provider] node test/record-fixture.mjs
//
// The verifier redacts the API key server-side; this script double-checks
// before writing the fixture to test/fixtures/<label>.json.
// Run test/check-fixtures.mjs afterwards (or in CI) to catch family-detection drift.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const endpoint = process.env.LIVE_ENDPOINT;
const apiKey = process.env.LIVE_API_KEY;
const model = process.env.LIVE_MODEL || "";

if (!endpoint || !apiKey) {
  console.error("Set LIVE_ENDPOINT and LIVE_API_KEY to record a fixture.");
  process.exit(1);
}

const label = (process.env.LIVE_LABEL || new URL(endpoint).hostname)
  .replace(/[^a-z0-9.-]+/gi, "-")
  .replace(/^-+|-+$/g, "") || "endpoint";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      ready = (await fetch(base)).ok;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("The verifier did not start.");

  const response = await fetch(`${base}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint, apiKey, model }),
  });
  const report = await response.json();
  if (!response.ok) throw new Error(report.error || `Verification failed with HTTP ${response.status}.`);
  if (JSON.stringify(report).includes(apiKey)) throw new Error("The API key leaked into the report; fixture not written.");

  mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
  const fixturePath = new URL(`./fixtures/${label}.json`, import.meta.url);
  writeFileSync(fixturePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Fixture written: ${fixturePath.pathname}`);
} finally {
  child.kill("SIGTERM");
}
