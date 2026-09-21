import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import { Error404 } from "@/components/ui/error-404.tsx";
import Layout from "@/components/layouts/global/layout.tsx";
import { useTrackOrigin } from "@/hooks/use-track-origin";

// ShareLayout is route-split: its ShareShell chrome pulls in the table of
// contents (and thus TipTap), so keeping it out of the eager graph removes the
// editor engine from startup for authenticated users too.
const ShareLayout = lazy(
  () => import("@/features/share/components/share-layout.tsx"),
);

// Auth / entry pages stay eager: they are the first paint for an unauthenticated
// visitor (e.g. /login) and are already small, so code-splitting them would only
// add a cold-chunk round trip to the most common cold-start path.
import SetupWorkspace from "@/pages/auth/setup-workspace.tsx";
import LoginPage from "@/pages/auth/login";
import InviteSignup from "@/pages/auth/invite-signup.tsx";
import ForgotPassword from "@/pages/auth/forgot-password.tsx";
import PasswordReset from "./pages/auth/password-reset";
import PageRedirect from "@/pages/page/page-redirect.tsx";
import ShareRedirect from "@/pages/share/share-redirect.tsx";

// Heavy / leaf pages are route-split with React.lazy so their code (most
// importantly the whole TipTap editor + KaTeX + lowlight grammars + drawio that
// the page editor and the readonly share editor pull in) is fetched only when
// the matching route is actually visited. The <Suspense> boundaries live inside
// each Layout (around its <Outlet/>), so the app shell stays mounted while a
// route chunk loads.
const Home = lazy(() => import("@/pages/dashboard/home"));
const Page = lazy(() => import("@/pages/page/page"));
const SpaceHome = lazy(() => import("@/pages/space/space-home.tsx"));
const SpaceTrash = lazy(() => import("@/pages/space/space-trash.tsx"));
const SpacesPage = lazy(() => import("@/pages/spaces/spaces.tsx"));
const FavoritesPage = lazy(() => import("@/pages/favorites/favorites-page"));
const LabelPage = lazy(() => import("@/pages/label/label-page"));
const SharedPage = lazy(() => import("@/pages/share/shared-page.tsx"));

const AccountSettings = lazy(
  () => import("@/pages/settings/account/account-settings"),
);
const AccountPreferences = lazy(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
// #506 — lazy leaf (own chunk): the API-keys management page is route-split so
// its code (Mantine table/modals + the create/revoke flow) stays out of the
// entry bundle (post-#342 bundle discipline).
const AccountApiKeys = lazy(
  () => import("@/pages/settings/account/account-api-keys.tsx"),
);
// #686 — lazy leaf (own chunk): the personal MCP-servers page carries the shared
// Mantine form/modal + create/test flow, so it is route-split out of the entry
// bundle like the API-keys page.
const AccountMcpServers = lazy(
  () => import("@/pages/settings/account/account-mcp-servers.tsx"),
);
const WorkspaceSettings = lazy(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
const AiSettings = lazy(() => import("@/pages/settings/workspace/ai-settings"));
const WorkspaceMembers = lazy(
  () => import("@/pages/settings/workspace/workspace-members"),
);
const Groups = lazy(() => import("@/pages/settings/group/groups"));
const GroupInfo = lazy(() => import("./pages/settings/group/group-info"));
const Spaces = lazy(() => import("@/pages/settings/space/spaces.tsx"));
const Shares = lazy(() => import("@/pages/settings/shares/shares.tsx"));

export default function App() {
  useTrackOrigin();

  return (
    <Suspense
      fallback={
        <Center h="100vh">
          <Loader size="sm" />
        </Center>
      }
    >
      <Routes>
        <Route index element={<Navigate to="/home" />} />
        <Route path={"/login"} element={<LoginPage />} />
        <Route path={"/invites/:invitationId"} element={<InviteSignup />} />
        <Route path={"/forgot-password"} element={<ForgotPassword />} />
        <Route path={"/password-reset"} element={<PasswordReset />} />

        <Route path={"/setup/register"} element={<SetupWorkspace />} />

        <Route element={<ShareLayout />}>
          <Route
            path={"/share/:shareId/p/:pageSlug"}
            element={<SharedPage />}
          />
          <Route path={"/share/p/:pageSlug"} element={<SharedPage />} />
        </Route>

        <Route path={"/share/:shareId"} element={<ShareRedirect />} />
        <Route path={"/p/:pageSlug"} element={<PageRedirect />} />

        <Route element={<Layout />}>
          <Route path={"/home"} element={<Home />} />
          <Route path={"/spaces"} element={<SpacesPage />} />
          <Route path={"/favorites"} element={<FavoritesPage />} />
          <Route path={"/labels/:labelName"} element={<LabelPage />} />
          <Route path={"/s/:spaceSlug"} element={<SpaceHome />} />
          <Route path={"/s/:spaceSlug/trash"} element={<SpaceTrash />} />
          <Route
            path={"/s/:spaceSlug/p/:pageSlug"}
            element={<Page />}
          />

          <Route path={"/settings"}>
            <Route path={"account/profile"} element={<AccountSettings />} />
            <Route
              path={"account/preferences"}
              element={<AccountPreferences />}
            />
            <Route path={"account/api-keys"} element={<AccountApiKeys />} />
            <Route
              path={"account/mcp-servers"}
              element={<AccountMcpServers />}
            />
            <Route path={"workspace"} element={<WorkspaceSettings />} />
            <Route path={"ai"} element={<AiSettings />} />
            <Route path={"members"} element={<WorkspaceMembers />} />
            <Route path={"groups"} element={<Groups />} />
            <Route path={"groups/:groupId"} element={<GroupInfo />} />
            <Route path={"spaces"} element={<Spaces />} />
            <Route path={"sharing"} element={<Shares />} />
          </Route>
        </Route>

        <Route path="*" element={<Error404 />} />
      </Routes>
    </Suspense>
  );
}
