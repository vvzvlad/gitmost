// Unit tests for the drawioShapes verified-stencil catalog (issue #424).
// Covers acceptance #1: a "lambda" query returns a valid mxgraph.aws4 icon with
// the right service/resource pattern + sizes; a blocklisted stencil query
// returns its working replacement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchShapes,
  awsServiceStyle,
  azureImageStyle,
  loadShapeIndex,
  AWS_CATEGORY_FILL,
} from "../../build/lib/drawio-shapes.js";

test("the bundled index loads and is the real ~10k-shape catalog", () => {
  const idx = loadShapeIndex();
  assert.ok(Array.isArray(idx));
  assert.ok(idx.length > 10000, `expected >10000 shapes, got ${idx.length}`);
  // Record shape { style, w, h, title, tags, type }.
  for (const k of ["style", "w", "h", "title", "tags", "type"]) {
    assert.ok(k in idx[0], `record missing key ${k}`);
  }
});

test('drawioShapes("lambda") returns a valid mxgraph.aws4 service icon', () => {
  const results = searchShapes("lambda", { limit: 5 });
  assert.ok(results.length > 0);
  // Acceptance #1: a valid aws4 service-level icon (resourceIcon + resIcon)
  // for lambda, with sensible default sizes, is present.
  const svc = results.find(
    (r) =>
      /shape=mxgraph\.aws4\.resourceIcon/.test(r.style) &&
      /resIcon=mxgraph\.aws4\.lambda(_function)?\b/.test(r.style),
  );
  assert.ok(svc, `no aws4 lambda service icon in ${JSON.stringify(results.map((r) => r.style.slice(-40)))}`);
  assert.ok(svc.w > 0 && svc.h > 0, "icon must carry default w/h");
  // The current-generation aws4 icon must outrank the deprecated aws3 one.
  assert.match(results[0].style, /mxgraph\.aws4/);
});

test("a blocklisted stencil query returns its replacement + a note", () => {
  const results = searchShapes("dynamodb_table", { limit: 3 });
  assert.ok(results.length > 0);
  const rep = results[0];
  // dynamodb_table (empty box) -> dynamodb.
  assert.match(rep.style, /resIcon=mxgraph\.aws4\.dynamodb\b/);
  assert.ok(rep.note && /dynamodb_table/.test(rep.note), "note must explain the replacement");
  // The broken stencil name must NOT be returned as a usable style.
  assert.ok(
    !results.some((r) => /resIcon=mxgraph\.aws4\.dynamodb_table\b/.test(r.style)),
    "the broken dynamodb_table stencil must not be returned",
  );
});

test("an AWS rebranding query returns the real (renamed) resIcon", () => {
  const os = searchShapes("opensearch", { limit: 3 });
  assert.ok(
    os.some((r) => /resIcon=mxgraph\.aws4\.elasticsearch_service\b/.test(r.style) && r.note),
    "OpenSearch must map to elasticsearch_service with a note",
  );
  const msk = searchShapes("msk", { limit: 3 });
  assert.ok(
    msk.some((r) => /managed_streaming_for_kafka/.test(r.style)),
    "MSK must map to managed_streaming_for_kafka",
  );
});

test("category filter narrows results", () => {
  const all = searchShapes("database", { limit: 20 });
  const dbOnly = searchShapes("database", { category: "Database", limit: 20 });
  assert.ok(dbOnly.length <= all.length);
});

test("limit is honoured and capped", () => {
  assert.equal(searchShapes("aws", { limit: 3 }).length, 3);
  assert.ok(searchShapes("aws", { limit: 999 }).length <= 50);
});

test("empty query returns nothing", () => {
  assert.deepEqual(searchShapes("   "), []);
});

test("style builders match the appendix templates", () => {
  const s = awsServiceStyle("lambda", "Compute");
  assert.match(s, /strokeColor=#ffffff/); // mandatory for service-level
  assert.match(s, new RegExp(`fillColor=${AWS_CATEGORY_FILL.Compute}`));
  assert.match(s, /shape=mxgraph\.aws4\.resourceIcon;resIcon=mxgraph\.aws4\.lambda$/);
  const az = azureImageStyle("databases/Azure_Cosmos_DB.svg");
  assert.match(az, /image=img\/lib\/azure2\/databases\/Azure_Cosmos_DB\.svg/);
});

test("azure and group queries surface the curated overlay", () => {
  const cosmos = searchShapes("cosmos", { limit: 5 });
  assert.ok(cosmos.some((r) => /azure2\/databases\/Azure_Cosmos_DB\.svg/.test(r.style)));
  const vpc = searchShapes("vpc group", { limit: 5 });
  assert.ok(vpc.some((r) => /grIcon=mxgraph\.aws4\.group_vpc2/.test(r.style)));
});
