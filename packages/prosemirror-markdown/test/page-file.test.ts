import { describe, it, expect } from "vitest";
import { parsePageFile, serializePageFile } from "../src/lib/page-file";

describe("page-file thin format", () => {
  it("round-trips id frontmatter + clean body", () => {
    const text = serializePageFile("019ef6fc-2638", "# Hello\n\nbody text");
    expect(text.startsWith("---\ngitmost_id: 019ef6fc-2638\n---\n")).toBe(true);
    const { id, body } = parsePageFile(text);
    expect(id).toBe("019ef6fc-2638");
    expect(body).toBe("# Hello\n\nbody text");
  });

  it("serialization is deterministic (byte-identical for the same input)", () => {
    expect(serializePageFile("p", "x")).toBe(serializePageFile("p", "x"));
  });

  it("reads id from frontmatter with quotes / extra fields", () => {
    expect(parsePageFile('---\ngitmost_id: "abc"\ntitle: ignored\n---\nbody').id).toBe("abc");
    expect(parsePageFile("---\ngitmost_id: 'xyz'\n---\nbody").id).toBe("xyz");
  });


  it("ADOPT: a plain hand-written file has no id and keeps its whole body", () => {
    const { id, body } = parsePageFile("# Just a note\n\nwritten in Obsidian");
    expect(id).toBeNull();
    expect(body).toBe("# Just a note\n\nwritten in Obsidian");
  });

  it("tolerates empty / whitespace input", () => {
    expect(parsePageFile("").id).toBeNull();
    expect(parsePageFile("   \n  ").body).toBe("");
  });
});
