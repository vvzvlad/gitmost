import { atom } from "jotai";
// Type-only: these atoms only hold an Editor reference for typing. A value
// import would drag the whole @tiptap/core engine into the eager graph of every
// shell component that reads one of these atoms.
import type { Editor } from "@tiptap/core";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import type { DictationUnavailableReason } from "@/features/dictation/dictation-status";

export const pageEditorAtom = atom<Editor | null>(null);

// #370 — the active page's collab provider, published by the page editor so the
// header menu can emit the "save-version" stateless signal (Cmd+S / button).
// Null when the page is read-only / collab isn't connected. A typed initial
// value (rather than an explicit generic) keeps jotai's overload resolution on
// the writable PrimitiveAtom branch.
const initialCollabProvider: HocuspocusProvider | null = null;
export const collabProviderAtom = atom(initialCollabProvider);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

export const showLinkMenuAtom = atom(false);

// Current page's edit mode — initialized from the user's saved preference on
// first load, can be toggled locally without persisting to the server.
export const currentPageEditModeAtom = atom<PageEditMode>(PageEditMode.Edit);

// Whether the dictation mic can start, and (when it can't) the cause-specific
// reason the mic button surfaces as a tooltip. Published by the page editor,
// consumed by DictationGroup -> MicButton.
export type DictationAvailability = {
  isEditable: boolean;
  reason: DictationUnavailableReason | null;
};
export const dictationAvailabilityAtom = atom<DictationAvailability>({
  isEditable: false,
  reason: null,
});

// #564 — the body is live (painted from the LOCAL ydoc) but the collab room is
// Disconnected, so what's on screen is an un-reconciled local copy and edits are
// blocked. Published by the page editor and consumed by FullEditor, which shows
// the page-wide "offline, showing the cached copy" banner: it must cover the
// chrome too (title/icon come from the #563 page-meta boot cache — a different
// point in time than the body), otherwise the chrome looks authoritative
// (guard 5).
export const bodyLocalOnlyAtom = atom<{ isOffline: boolean }>({
  isOffline: false,
});

// #564 — the body's Yjs write guard is ARMED and REJECTING: the live editor is
// bound to a local ydoc the remote room has not confirmed yet, so ANY doc-
// changing transaction is dropped on the floor.
//
// This is published because a dropped transaction is invisible to its caller:
// ProseMirror's `filterTransaction` gives no feedback, so a PROGRAMMATIC write
// (history restore, comment resolve/delete mark updates) would report success
// while its change never reached the document. Every such path must consult this
// and refuse — see local-first-body.ts (guard 2). The typing path needs no such
// check: the editor is not editable in this window.
export const bodyWriteBlockedAtom = atom<boolean>(false);
