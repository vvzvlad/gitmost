import { describe, it, expect } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { UniqueID } from "./unique-id";

// #709 — the UniqueID override against a long-lived collaboration provider:
// a fake with only what the override touches (isSynced + "synced" on/off).
function fakeProvider(isSynced: boolean) {
  const listeners: Array<() => void> = [];
  return {
    isSynced,
    listeners,
    on(event: string, cb: () => void) {
      if (event === "synced") listeners.push(cb);
    },
    off(event: string, cb: () => void) {
      const i = listeners.indexOf(cb);
      if (event === "synced" && i !== -1) listeners.splice(i, 1);
    },
  };
}

// Stand-in for the Collaboration extension: the override finds it by name and
// reads its `provider` option.
const fakeCollaboration = (provider: ReturnType<typeof fakeProvider>) =>
  Extension.create({
    name: "collaboration",
    addOptions: () => ({ provider }),
  });

async function makeEditor(provider: ReturnType<typeof fakeProvider>) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      fakeCollaboration(provider),
      UniqueID.configure({ types: ["paragraph"] }),
    ],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    },
  });
  // tiptap emits "create" (UniqueID's onCreate) on a 0 ms timer.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}

const firstParagraphId = (editor: Editor) =>
  editor.state.doc.firstChild?.attrs.id;

describe("#709 UniqueID override on a long-lived provider", () => {
  it("an already synced provider: ids are created right away, no 'synced' listener is left", async () => {
    const provider = fakeProvider(true);
    const editor = await makeEditor(provider);

    expect(firstParagraphId(editor)).toEqual(expect.any(String));
    expect(provider.listeners).toHaveLength(0);
    editor.destroy();
  });

  it("a not yet synced provider: ids are created on 'synced', which then unsubscribes", async () => {
    const provider = fakeProvider(false);
    const editor = await makeEditor(provider);

    expect(firstParagraphId(editor)).toBeNull();
    expect(provider.listeners).toHaveLength(1);

    [...provider.listeners].forEach((cb) => cb());
    expect(firstParagraphId(editor)).toEqual(expect.any(String));
    expect(provider.listeners).toHaveLength(0);
    editor.destroy();
  });

  it("an editor destroyed before 'synced' leaves no listener on the provider", async () => {
    const provider = fakeProvider(false);
    const editor = await makeEditor(provider);
    expect(provider.listeners).toHaveLength(1);

    editor.destroy();
    expect(provider.listeners).toHaveLength(0);
  });
});
