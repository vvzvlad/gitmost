import { useEffect } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { IUser } from "@/features/user/types/user.types";

export function usePagePresence(
  provider: HocuspocusProvider | undefined,
  user: IUser | undefined,
  editing: boolean,
) {
  const id = user?.id;
  const name = user?.name;
  const avatarUrl = user?.avatarUrl;
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness || !id) return;
    awareness.setLocalStateField("pagePresence", {
      id,
      name,
      avatarUrl,
      mode: editing ? "editing" : "viewing",
    });
    return () => {
      awareness.setLocalStateField("pagePresence", null);
    };
  }, [provider, id, name, avatarUrl, editing]);
}
