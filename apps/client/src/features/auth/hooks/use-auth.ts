import { useState } from "react";
import {
  forgotPassword,
  login,
  logout,
  passwordReset,
  setupWorkspace,
  verifyUserToken,
} from "@/features/auth/services/auth-service";
import { useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import {
  IForgotPassword,
  ILogin,
  IPasswordReset,
  ISetupWorkspace,
  IVerifyUserToken,
} from "@/features/auth/types/auth.types";
import { notifications } from "@mantine/notifications";
import { IAcceptInvite } from "@/features/workspace/types/workspace.types.ts";
import { acceptInvitation } from "@/features/workspace/services/workspace-service.ts";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route.ts";
import { RESET } from "jotai/utils";
import { useTranslation } from "react-i18next";
import { clearPersistedTreeCaches } from "@/features/page/tree/atoms/tree-data-atom";
import { purgePageYdocDatabases } from "@/features/editor/page-ydoc-eviction";

export default function useAuth() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const [, setCurrentUser] = useAtom(currentUserAtom);

  const handleSignIn = async (data: ILogin) => {
    setIsLoading(true);

    try {
      await login(data);

      // Cross-user hygiene (#563). Logging OUT purges the persisted caches, but a
      // session can also end without a logout (expired cookie, closed tab), which
      // leaves the previous user's tree + page-meta caches — and their `currentUser`
      // — in localStorage. Sign-in is an SPA navigation, and `currentUser` is only
      // replaced by `/me` a tick later, so without this the first commit after
      // sign-in would render the NEW user under the OLD user's scope key and paint
      // the old user's cached page titles/icons.
      // RESET makes the scope `anon` (fail-closed: both caches refuse it) and the
      // sweep drops the previous user's blobs from disk. `freezeWrites: false`:
      // unlike logout, we stay in this session, so persistence must keep working.
      setCurrentUser(RESET);
      clearPersistedTreeCaches({ freezeWrites: false });
      // #626 / #640 — also drop the previous user's local page-body ydoc
      // databases, so a different user signing in on a shared browser never
      // inherits them (namespacing already prevents cross-scope reads; this is
      // the belt-and-suspenders physical delete). AWAITED (#640, part 4): the
      // navigate() below is an SPA transition, and without the await the deletion
      // would race the next user's first page open.
      await purgePageYdocDatabases();

      setIsLoading(false);

      navigate(getPostLoginRedirect());
    } catch (err) {
      setIsLoading(false);

      const message = err.response?.data?.message;
      notifications.show({
        message,
        color: "red",
      });
    }
  };

  const handleInvitationSignUp = async (data: IAcceptInvite) => {
    setIsLoading(true);

    try {
      const response = await acceptInvitation(data);
      setIsLoading(false);

      if (response?.requiresLogin) {
        notifications.show({
          message: t(
            "Account created successfully. Please log in to set up two-factor authentication.",
          ),
        });
        navigate(APP_ROUTE.AUTH.LOGIN);
      } else {
        navigate(APP_ROUTE.HOME);
      }
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handleSetupWorkspace = async (data: ISetupWorkspace) => {
    setIsLoading(true);

    try {
      await setupWorkspace(data);
      setIsLoading(false);
      navigate(APP_ROUTE.HOME);
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handlePasswordReset = async (data: IPasswordReset) => {
    setIsLoading(true);

    try {
      const response = await passwordReset(data);
      setIsLoading(false);

      if (response?.requiresLogin) {
        notifications.show({
          message: t(
            "Password reset was successful. Please log in with your new password.",
          ),
        });
        navigate(APP_ROUTE.AUTH.LOGIN);
      } else {
        navigate(APP_ROUTE.HOME);
        notifications.show({
          message: t("Password reset was successful"),
        });
      }
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handleLogout = async () => {
    setCurrentUser(RESET);
    // Purge the persisted sidebar tree caches (they contain page titles) so the
    // cached page titles aren't left readable in localStorage on a shared
    // machine. (Only the tree caches are swept; other localStorage entries
    // remain.)
    clearPersistedTreeCaches();
    // #626 / #640 — purge the local page-body ydoc databases too: on a shared
    // machine they would otherwise stay readable on disk after logout. AWAITED
    // (#640, part 4) BEFORE the window.location.replace below, otherwise the
    // synchronous redirect tears this tab down before `deleteDatabase` finishes.
    // The purge broadcasts a "close your ydocs" message so other tabs release
    // their IDB handles and the delete is not silently blocked.
    await purgePageYdocDatabases();
    await logout();
    window.location.replace(`${APP_ROUTE.AUTH.LOGIN}?logout=1`);
  };

  const handleForgotPassword = async (data: IForgotPassword) => {
    setIsLoading(true);

    try {
      await forgotPassword(data);
      setIsLoading(false);

      return true;
    } catch (err) {
      console.log(err);
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });

      return false;
    }
  };

  const handleVerifyUserToken = async (data: IVerifyUserToken) => {
    setIsLoading(true);

    try {
      await verifyUserToken(data);
      setIsLoading(false);
    } catch (err) {
      console.log(err);
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  return {
    signIn: handleSignIn,
    invitationSignup: handleInvitationSignUp,
    setupWorkspace: handleSetupWorkspace,
    forgotPassword: handleForgotPassword,
    passwordReset: handlePasswordReset,
    verifyUserToken: handleVerifyUserToken,
    logout: handleLogout,
    isLoading,
  };
}
