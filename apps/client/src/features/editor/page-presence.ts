import { userColors } from "./extensions/utils";

export interface PageParticipant {
  id: string;
  name: string;
  avatarUrl?: string;
  color: string;
  mode: "viewing" | "editing";
}

export function participantColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return userColors[(hash >>> 0) % userColors.length];
}

export function collectParticipants(
  states: Iterable<Record<string, any>>,
): PageParticipant[] {
  const people = new Map<string, PageParticipant>();
  for (const state of states) {
    const person = state.pagePresence;
    if (
      !person ||
      typeof person.id !== "string" ||
      !person.id ||
      typeof person.name !== "string" ||
      !["viewing", "editing"].includes(person.mode)
    )
      continue;
    const previous = people.get(person.id);
    if (!previous || person.mode === "editing") {
      people.set(person.id, {
        id: person.id,
        name: person.name,
        avatarUrl:
          typeof person.avatarUrl === "string" ? person.avatarUrl : undefined,
        color: participantColor(person.id),
        mode: person.mode,
      });
    }
  }
  return [...people.values()].sort((a, b) => a.id.localeCompare(b.id));
}
