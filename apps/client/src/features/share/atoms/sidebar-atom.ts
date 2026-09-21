import { atomWithUiStorage } from "@/lib/jotai-helper.ts";
import { atom } from "jotai";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

// Persisted UI chrome: whether the shared-page table-of-contents aside is shown.
export const tableOfContentAsideAtom = atomWithUiStorage<boolean>(
  "showTOC",
  true,
  isBoolean,
);

export const mobileTableOfContentAsideAtom = atom<boolean>(false);
