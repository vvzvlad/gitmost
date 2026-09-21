import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import ShareShell from "@/features/share/components/share-shell.tsx";

export default function ShareLayout() {
  return (
    <ShareShell>
      <Suspense
        fallback={
          <Center h="60vh">
            <Loader size="sm" />
          </Center>
        }
      >
        <Outlet />
      </Suspense>
    </ShareShell>
  );
}
