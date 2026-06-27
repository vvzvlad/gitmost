import { describe, it, expect } from "vitest";
import { WebSocketStatus } from "@hocuspocus/provider";
import { isCollabSynced, isBodyEditable } from "./editor-sync-state";

describe("isCollabSynced", () => {
  it("is true only when Connected and synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connected, true)).toBe(true);
  });

  it("is false while connecting or not yet synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connecting, true)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Connected, false)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Disconnected, true)).toBe(false);
  });
});

describe("isBodyEditable (pre-sync data-loss gate, #218)", () => {
  const base = { editable: true, inEditMode: true, showStatic: false };

  it("allows editing only after the static (pre-sync) phase ends", () => {
    expect(isBodyEditable(base)).toBe(true);
  });

  it("never editable while the static read-only editor is shown", () => {
    expect(isBodyEditable({ ...base, showStatic: true })).toBe(false);
  });

  it("honors read-only and view mode", () => {
    expect(isBodyEditable({ ...base, editable: false })).toBe(false);
    expect(isBodyEditable({ ...base, inEditMode: false })).toBe(false);
  });
});
