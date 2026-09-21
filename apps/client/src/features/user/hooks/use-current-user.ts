import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { getMyInfo } from "@/features/user/services/user-service";
import { ICurrentUser } from "@/features/user/types/user.types";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { isLocalFirstEnabled } from "@/lib/config";

export default function useCurrentUser(): UseQueryResult<ICurrentUser> {
  // #642, parts 1+2 — seed the query from the persisted current-user so the very
  // first frame already has status:'success' (isLoading false). That lets
  // UserProvider pass through its `/me` gate (user-provider.tsx) BEFORE `/me`
  // answers, removing the first of two serial RTTs on page open. The WHOLE
  // ICurrentUser is seeded (identity + workspace + role, #642 part 2): staleness
  // is bounded to a single RTT and self-heals (refetchOnMount:'always' below
  // refetches immediately), and the server stays authoritative — a click on a
  // stale affordance returns 403.
  //
  // With `initialData` react-query reports status:'success' but keeps
  // `isFetched:false` (dataUpdateCount stays 0) until the real `/me` resolves —
  // useRedirectIfAuthenticated relies on exactly that to avoid a login loop
  // (#642 part 4). `staleTime:0` + `refetchOnMount:"always"` guarantee the seed
  // is only a first-frame placeholder that the network overwrites within one RTT.
  //
  // Gated on `isLocalFirstEnabled()`: with the flag OFF, or with NO persisted
  // user (first visit / post-logout), we fall back to today's plain query
  // (isLoading true → today's empty gate), so that path is byte-for-behavior
  // unchanged and there is no regression.
  const persistedUser = useAtomValue(currentUserAtom);
  const seed =
    isLocalFirstEnabled() && persistedUser ? persistedUser : undefined;

  return useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      return await getMyInfo();
    },
    ...(seed
      ? {
          initialData: seed,
          staleTime: 0,
          refetchOnMount: "always" as const,
        }
      : {}),
  });
}
