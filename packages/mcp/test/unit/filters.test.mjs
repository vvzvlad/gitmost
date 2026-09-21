import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterComment,
  filterPage,
  filterSearchResult,
} from "../../build/lib/filters.js";

test("filterComment includes resolvedAt/resolvedById as null when absent", () => {
  const result = filterComment({
    id: "c1",
    pageId: "p1",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(result.resolvedAt, null);
  assert.equal(result.resolvedById, null);
});

test("filterComment passes through resolvedAt/resolvedById when present", () => {
  const result = filterComment({
    id: "c1",
    pageId: "p1",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-02-02T10:00:00.000Z",
    resolvedById: "user-42",
  });

  assert.equal(result.resolvedAt, "2026-02-02T10:00:00.000Z");
  assert.equal(result.resolvedById, "user-42");
});

test("filterComment still includes id/content/createdAt", () => {
  const result = filterComment({
    id: "c-id",
    pageId: "p1",
    content: "the body",
    createdAt: "2026-03-03T03:03:03.000Z",
  });

  assert.equal(result.id, "c-id");
  assert.equal(result.content, "the body");
  assert.equal(result.createdAt, "2026-03-03T03:03:03.000Z");
});

test("filterComment uses markdownContent override when provided", () => {
  const result = filterComment(
    {
      id: "c1",
      pageId: "p1",
      content: "raw json content",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    "**markdown** content",
  );

  assert.equal(result.content, "**markdown** content");
});

test("filterComment is null-safe on missing creator", () => {
  const result = filterComment({
    id: "c1",
    pageId: "p1",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    creatorId: "u1",
    // no `creator` object present
  });

  assert.equal(result.creatorName, null);
  assert.equal(result.creatorId, "u1");
});

test("filterComment reads creator.name when creator present", () => {
  const result = filterComment({
    id: "c1",
    pageId: "p1",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    creator: { name: "Alice" },
  });

  assert.equal(result.creatorName, "Alice");
});

test("filterComment defaults selection/type/parentCommentId/editedAt", () => {
  const result = filterComment({
    id: "c1",
    pageId: "p1",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(result.selection, null);
  assert.equal(result.type, "page");
  assert.equal(result.parentCommentId, null);
  assert.equal(result.editedAt, null);
});

test("filterPage selects expected fields", () => {
  const result = filterPage({
    id: "page-1",
    slugId: "slug-1",
    title: "My Page",
    parentPageId: "parent-1",
    spaceId: "space-1",
    isLocked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
    // extra fields that must be dropped
    extraneous: "should not appear",
    content: "should be ignored when not passed as arg",
  });

  assert.deepEqual(result, {
    id: "page-1",
    slugId: "slug-1",
    title: "My Page",
    parentPageId: "parent-1",
    spaceId: "space-1",
    isLocked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    deletedAt: null,
  });
});

test("filterPage omits content key when content arg is not a string", () => {
  const result = filterPage({ id: "p1", title: "t" });
  assert.equal("content" in result, false);
});

test("filterPage includes content when arg is a string", () => {
  const result = filterPage({ id: "p1", title: "t" }, "# Heading");
  assert.equal(result.content, "# Heading");
});

test("filterPage includes content when arg is an empty string", () => {
  const result = filterPage({ id: "p1", title: "t" }, "");
  assert.equal("content" in result, true);
  assert.equal(result.content, "");
});

test("filterPage omits subpages when none provided", () => {
  const result = filterPage({ id: "p1", title: "t" });
  assert.equal("subpages" in result, false);
});

test("filterPage omits subpages when an empty array is provided", () => {
  const result = filterPage({ id: "p1", title: "t" }, undefined, []);
  assert.equal("subpages" in result, false);
});

test("filterPage maps subpages to id/title only", () => {
  const result = filterPage({ id: "p1", title: "t" }, undefined, [
    { id: "s1", title: "Sub One", extra: "drop" },
    { id: "s2", title: "Sub Two" },
  ]);

  assert.deepEqual(result.subpages, [
    { id: "s1", title: "Sub One" },
    { id: "s2", title: "Sub Two" },
  ]);
});

test("filterPage includes both content and subpages together", () => {
  const result = filterPage({ id: "p1", title: "t" }, "body", [
    { id: "s1", title: "Sub" },
  ]);

  assert.equal(result.content, "body");
  assert.deepEqual(result.subpages, [{ id: "s1", title: "Sub" }]);
});

// --- filterSearchResult (#443 agent-lookup contract) -------------------------

test("filterSearchResult maps the lookup shape to {pageId,title,path,snippet,score}", () => {
  const result = filterSearchResult({
    id: "0199aa-uuid",
    slugId: "slug-secret",
    title: "backup-srv.local",
    parentPageId: "0199pp",
    path: ["Infrastructure", "Datacenter A", "Servers"],
    snippet: "…IP: 10.0.12.5. Debian 12…",
    score: 0.92,
  });

  assert.deepEqual(result, {
    pageId: "0199aa-uuid",
    title: "backup-srv.local",
    path: ["Infrastructure", "Datacenter A", "Servers"],
    snippet: "…IP: 10.0.12.5. Debian 12…",
    score: 0.92,
  });
});

test("filterSearchResult NEVER exposes slugId (pageId is the only identifier)", () => {
  const result = filterSearchResult({
    id: "uuid-1",
    slugId: "slug-1",
    title: "t",
    path: [],
    snippet: "s",
    score: 0.1,
  });
  assert.equal("slugId" in result, false);
  assert.equal("id" in result, false);
  assert.equal(result.pageId, "uuid-1");
});

test("filterSearchResult root page yields path: []", () => {
  const result = filterSearchResult({
    id: "uuid-root",
    title: "Root",
    path: [],
    snippet: "s",
    score: 0.5,
  });
  assert.deepEqual(result.path, []);
});

test("filterSearchResult degrades a legacy FTS hit (no lookup fields)", () => {
  // Stock upstream stripped the opt-in DTO fields → legacy shape with
  // highlight + rank and no path/snippet/score.
  const result = filterSearchResult({
    id: "uuid-legacy",
    slugId: "slug-legacy",
    title: "Legacy",
    parentPageId: null,
    rank: 0.37,
    highlight: "…matched <b>text</b>…",
    space: { id: "sp1", name: "Space" },
  });

  assert.equal(result.pageId, "uuid-legacy");
  assert.equal(result.title, "Legacy");
  // snippet falls back to highlight, score to rank, path to [].
  assert.equal(result.snippet, "…matched <b>text</b>…");
  assert.equal(result.score, 0.37);
  assert.deepEqual(result.path, []);
  assert.equal("slugId" in result, false);
});

test("filterSearchResult is null-safe on missing snippet/score/path", () => {
  const result = filterSearchResult({ id: "u", title: "t" });
  assert.equal(result.pageId, "u");
  assert.equal(result.snippet, "");
  assert.equal(result.score, 0);
  assert.deepEqual(result.path, []);
});

test("filterSearchResult ignores a non-array path", () => {
  const result = filterSearchResult({
    id: "u",
    title: "t",
    path: "not-an-array",
    snippet: "s",
    score: 1,
  });
  assert.deepEqual(result.path, []);
});
