import { Container, Loader, Space } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { getAppName } from "@/lib/config";
import { buildPageUrl } from "@/features/page/page.utils";
import { getPageById } from "@/features/page/services/page-service";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query";
import SpaceHomeTabs from "@/features/space/components/space-home-tabs";
import SpaceCreateNoteButtons from "@/features/space/components/space-create-note-buttons";

export default function SpaceHome() {
  const { spaceSlug } = useParams();
  const [params] = useSearchParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const homePageId =
    params.get("overview") === "1" ? undefined : space?.settings?.homePageId;
  const home = useQuery({
    queryKey: ["space-home-page", homePageId],
    queryFn: () => getPageById({ pageId: homePageId }),
    enabled: !!homePageId,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (homePageId && (home.isPending || home.isFetching)) return <Loader />;
  if (
    homePageId &&
    !home.isError &&
    home.data?.spaceId === space?.id &&
    !home.data?.deletedAt
  ) {
    return (
      <Navigate
        replace
        to={buildPageUrl(space.slug, home.data.slugId, home.data.title)}
      />
    );
  }

  return (
    <>
      <Helmet>
        <title>
          {space?.name || "Overview"} - {getAppName()}
        </title>
      </Helmet>
      <Container size="900" pt="xl">
        {space && (
          <>
            <SpaceCreateNoteButtons />
            <Space h="md" />
            <SpaceHomeTabs />
          </>
        )}
      </Container>
    </>
  );
}
