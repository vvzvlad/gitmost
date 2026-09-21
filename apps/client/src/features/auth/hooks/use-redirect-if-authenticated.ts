import { useEffect } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import { getPostLoginRedirect } from "@/lib/app-route.ts";
import { useNavigate } from "react-router-dom";

export function useRedirectIfAuthenticated() {
  const { data, isFetched, isSuccess } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    // #642, part 4 — require a CONFIRMED `/me` fetch, NOT a bare `data`. With
    // local-first ON, useCurrentUser seeds `data` from the persisted user via
    // react-query `initialData`, which makes status:'success' with `data.user`
    // present while `isFetched` is still false (no real fetch happened yet).
    // Redirecting on that seed would bounce /login → app → /me → 401, and the
    // 401 interceptor's currentUser purge (#642 part 3) turns that into an
    // infinite /login ⇄ app loop. `isFetched` flips true only after the network
    // `/me` actually resolves, so gate on it.
    //
    // Flag-OFF (and first visit): there is no seed, so `data` appears only after
    // a real fetch — `isFetched` is already true whenever `data` is present, so
    // this is behavior-equivalent to the previous `data && data.user` check.
    if (isFetched && isSuccess && data?.user) {
      navigate(getPostLoginRedirect());
    }
  }, [isFetched, isSuccess, data]);
}
