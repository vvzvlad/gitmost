/**
 * #370 — map a snapshot's intentionality tier to its badge metadata. `version:
 * true` marks the intentional points (manual / agent); autosaves (boundary /
 * idle / legacy null) are non-versions and get dimmed in the list.
 *
 * Extracted from history-item.tsx (#568) into a pure, UI-free module so the dense
 * revision-row adapter and the "Only versions" filter reuse the EXACT same
 * predicate as the badge — they can never drift when a new kind is added.
 */
export type HistoryKindMeta = {
  labelKey: string;
  color: string;
  version: boolean;
};

export function historyKindMeta(kind?: string | null): HistoryKindMeta {
  switch (kind) {
    case "manual":
      return { labelKey: "Saved", color: "blue", version: true };
    case "agent":
      return { labelKey: "Agent version", color: "violet", version: true };
    case "boundary":
      return { labelKey: "Boundary", color: "gray", version: false };
    default: // "idle" | null | undefined (legacy autosave)
      return { labelKey: "Autosave", color: "gray", version: false };
  }
}
