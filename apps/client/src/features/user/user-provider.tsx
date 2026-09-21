import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import React, { useEffect, useRef } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useTranslation } from "react-i18next";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { io } from "socket.io-client";
import { SOCKET_URL } from "@/features/websocket/types";
import { useQuerySubscription } from "@/features/websocket/use-query-subscription.ts";
import { useTreeSocket } from "@/features/websocket/use-tree-socket.ts";
import { useNotificationSocket } from "@/features/notification/hooks/use-notification-socket.ts";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { queryClient } from "@/main.tsx";
import { makeConnectHandler } from "@/features/user/connect-resync.ts";
import {
  triggerGuardedReload,
  useVersionReloadOnNavigation,
  surfacePreviousReloadBreadcrumb,
} from "@/features/user/guarded-reload.tsx";
import type { AppVersionSocketPayload } from "@/features/user/version-coherence.ts";
import { recordSessionVerified } from "@/features/user/session-verified";
import { isLocalFirstEnabled } from "@/lib/config";
import { reportOfflineCriticalServerError } from "@/lib/http-error";
import { resolveUserGate } from "@/features/user/user-provider-gate";
import { UserDegradedIndicator } from "@/features/user/user-degraded-indicator";

export function UserProvider({ children }: React.PropsWithChildren) {
  const [, setCurrentUser] = useAtom(currentUserAtom);
  const { data, isLoading, error, isError } = useCurrentUser();
  const { i18n } = useTranslation();
  const [, setSocket] = useAtom(socketAtom);
  // fetch collab token on load
  const { data: collab } = useCollabToken();

  // version-coherence: fire the armed one-shot reload on the next in-app
  // navigation (variant C — a safe point, not on tab backgrounding).
  useVersionReloadOnNavigation();

  // Surface any breadcrumb left by an auto-reload in the previous page load
  // (the reload cleared the console) so a field report stays diagnosable.
  useEffect(() => {
    surfacePreviousReloadBreadcrumb();
  }, []);

  // #641, part 4 — a 5xx on /me is a real (possibly partial) server outage, NOT
  // an offline condition. Count + report it once per distinct error object,
  // distinct from an unreachable network (which is the normal degraded mode).
  const reportedMeErrorRef = useRef<unknown>(null);
  useEffect(() => {
    if (!isLocalFirstEnabled() || !isError) return;
    if (reportedMeErrorRef.current === error) return;
    reportedMeErrorRef.current = error;
    reportOfflineCriticalServerError(error, "/users/me");
  }, [isError, error]);

  useEffect(() => {
    if (isLoading || isError) {
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ["websocket"],
      withCredentials: true,
    });

    // @ts-ignore
    setSocket(newSocket);

    // Distinguish the first connect from a reconnect so we only resync after a
    // gap. The handler owns the first-connect-vs-reconnect decision through a
    // private closure flag (see makeConnectHandler): on RECONNECT it refetches
    // the sidebar tree through the authorized API so the view re-converges after
    // a gap where ws events were missed (wifi blip, laptop sleep), invalidating
    // both the root level and the nested-page levels of every space tree.
    const handleConnect = makeConnectHandler(queryClient);
    newSocket.on("connect", () => {
      console.log("ws connected");
      handleConnect();
    });

    // Register the version-coherence listener SYNCHRONOUSLY, before the socket
    // connects: the server emits `app-version` immediately in handleConnection,
    // so a listener attached after connect would miss it on a fast localhost
    // connect. On a version mismatch the client shows a banner and defers the
    // auto-reload to the next in-app navigation (variant C — avoids reloading a
    // backgrounded tab that may hold unsaved input) before it hits a stale chunk.
    newSocket.on("app-version", (payload?: AppVersionSocketPayload) => {
      triggerGuardedReload(payload?.version);
    });

    return () => {
      console.log("ws disconnected");
      newSocket.disconnect();
    };
  }, [isError, isLoading]);

  useQuerySubscription();
  useTreeSocket();
  useNotificationSocket();

  useEffect(() => {
    if (data && data.user && data.workspace) {
      setCurrentUser(data);
      // #640, part 6 — stamp the network-independent session boundary on EVERY
      // successful `/me`. This is the only signal that lets the client tell a
      // session that is merely offline from one that has outlived its 30-day life
      // (JWT_TOKEN_EXPIRES_IN); past OFFLINE_GRACE the boot enforcement refuses
      // and purges local content even when no 401 ever arrives.
      recordSessionVerified();
      i18n.changeLanguage(
        data.user.locale === "en" ? "en-US" : data.user.locale,
      );
    }
  }, [data, isLoading]);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage || i18n.language || "en-US";
  }, [i18n.language, i18n.resolvedLanguage]);

  // #641, part 3 — the `/me` gate is now the offline-aware taxonomy (a pure,
  // tested decision). It keeps the app MOUNTED on a tolerated `/me` failure when
  // a user is already known, instead of collapsing everything to `<></>`.
  const gate = resolveUserGate({
    localFirst: isLocalFirstEnabled(),
    isLoading,
    error,
    hasData: Boolean(data),
  });

  if (gate === "loading") return <></>;
  if (gate === "error-404") return <Error404 />;
  if (gate === "blocked") return <></>;
  if (gate === "degraded") {
    // A `/me` error is being tolerated because we still have a user. Keep the app
    // mounted and surface the ONLY user-visible signal that the session is
    // degraded (silent on a healthy connection, sticky while it is down).
    return (
      <>
        {children}
        <UserDegradedIndicator />
      </>
    );
  }

  return <>{children}</>;
}
