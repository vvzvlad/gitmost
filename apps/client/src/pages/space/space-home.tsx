import {Container, Space} from "@mantine/core";
import SpaceHomeTabs from "@/features/space/components/space-home-tabs.tsx";
import SpaceCreateNoteButtons from "@/features/space/components/space-create-note-buttons.tsx";
import {useParams} from "react-router-dom";
import {useGetSpaceBySlugQuery} from "@/features/space/queries/space-query.ts";
import {getAppName} from "@/lib/config.ts";
import {Helmet} from "react-helmet-async";

export default function SpaceHome() {
    const {spaceSlug} = useParams();
    const {data: space} = useGetSpaceBySlugQuery(spaceSlug);

    return (
        <>
            <Helmet>
                <title>{space?.name || 'Overview'} - {getAppName()}</title>
            </Helmet>
            <Container size={"900"} pt="xl">
                {space && (
                    <>
                        <SpaceCreateNoteButtons/>
                        <Space h="md"/>
                        <SpaceHomeTabs/>
                    </>
                )}
            </Container>
        </>
    );
}
