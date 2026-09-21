import { describe, it, expect } from "vitest";
import { groupAgentRuns, runKey, GROUP_MIN } from "./group-agent-runs";
import { IComment } from "@/features/comment/types/comment.types";

const editComment = (id: string, over?: Partial<IComment>): IComment =>
  ({
    id,
    createdSource: "agent",
    aiChatId: "chat-1",
    agent: { name: "Corrector" },
    suggestedText: "new text",
    parentCommentId: null,
    ...over,
  }) as unknown as IComment;

const human = (id: string): IComment =>
  ({ id, createdSource: "user", parentCommentId: null }) as unknown as IComment;

describe("runKey", () => {
  it("keys a groupable agent edit on aiChatId + agent.name", () => {
    expect(runKey(editComment("a"))).toBe("chat-1:Corrector");
  });

  it("is null for an external MCP agent (aiChatId null)", () => {
    expect(runKey(editComment("a", { aiChatId: null }))).toBeNull();
  });

  it("is null for a non-edit agent comment (no suggestedText)", () => {
    expect(runKey(editComment("a", { suggestedText: null }))).toBeNull();
  });

  it("is null for a reply (has parentCommentId)", () => {
    expect(runKey(editComment("a", { parentCommentId: "p" }))).toBeNull();
  });

  it("is null for a human comment", () => {
    expect(runKey(human("a"))).toBeNull();
  });
});

describe("groupAgentRuns", () => {
  it("collapses >= GROUP_MIN same chat+role edits into one run at the first position", () => {
    const units = groupAgentRuns([
      editComment("e1"),
      editComment("e2"),
      editComment("e3"),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("run");
    if (units[0].kind === "run") {
      expect(units[0].key).toBe("chat-1:Corrector");
      expect(units[0].comments.map((c) => c.id)).toEqual(["e1", "e2", "e3"]);
    }
    expect(GROUP_MIN).toBe(2);
  });

  it("renders a lone edit as a single (below the threshold)", () => {
    const units = groupAgentRuns([editComment("e1")]);
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("single");
  });

  it("never groups external MCP edits (aiChatId null) — each is a single", () => {
    const units = groupAgentRuns([
      editComment("m1", { aiChatId: null }),
      editComment("m2", { aiChatId: null }),
    ]);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === "single")).toBe(true);
  });

  it("does not collapse two different roles sharing one chat", () => {
    const units = groupAgentRuns([
      editComment("a", { agent: { name: "Corrector" } as any }),
      editComment("b", { agent: { name: "FactChecker" } as any }),
    ]);
    // Each key has count 1 -> both remain singles.
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === "single")).toBe(true);
  });

  it("preserves order and keeps human threads as singles interleaved with a run", () => {
    const units = groupAgentRuns([
      human("h1"),
      editComment("e1"),
      editComment("e2"),
      human("h2"),
    ]);
    // h1 single, then the run (emitted at e1's position, e2 absorbed), then h2.
    expect(units.map((u) => u.kind)).toEqual(["single", "run", "single"]);
    if (units[1].kind === "run") {
      expect(units[1].comments.map((c) => c.id)).toEqual(["e1", "e2"]);
    }
  });
});
