// Replays recorded fixtures against the current family-detection heuristics
// to catch regex drift when vendors ship new model IDs. Run after
// test/record-fixture.mjs, or in CI on a schedule.

import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { familyFromModel } from "../lib/families.mjs";

let files = [];
try {
  files = readdirSync(new URL("./fixtures/", import.meta.url)).filter((name) => name.endsWith(".json"));
} catch {}

if (!files.length) {
  console.log("No live fixtures recorded yet; nothing to check.");
  process.exit(0);
}

for (const file of files) {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
  const models = fixture.selectedModels || [];
  for (const item of models) {
    assert.equal(familyFromModel(item.model), item.claimedFamily, `${file}: family detection drifted for ${item.model}`);
  }
  console.log(`${file}: ${models.length} model${models.length === 1 ? "" : "s"} ok`);
}
console.log("fixtures ok");
