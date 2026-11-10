import {Container} from "@mantine/core";
import SpaceHomeTabs from "@/features/space/components/space-home-tabs.tsx";
import {useParams} from "react-router-dom";
import {useGetSpaceBySlugQuery} from "@/features/space/queries/space-query.ts";
import {getAppName} from "@/lib/config.ts";
import {Helmet} from "react-helmet-async";
import {useSpaceAbility} from "@/features/space/permissions/use-space-ability.ts";
import {
    SpaceCaslAction,
    SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";
import {useHasFeature} from "@/ee/hooks/use-feature";
import {Feature} from "@/ee/features";
import {SpaceTemplatesSection} from "@/features/template/components/space-templates-section";

export default function SpaceHome() {
    const {spaceSlug} = useParams();
    const {data: space} = useGetSpaceBySlugQuery(spaceSlug);
    const spaceAbility = useSpaceAbility(space?.membership?.permissions);
    const hasTemplates = useHasFeature(Feature.TEMPLATES);
    const canCreatePages = spaceAbility.can(
        SpaceCaslAction.Manage,
        SpaceCaslSubject.Page,
    );

    return (
        <>
            <Helmet>
                <title>{space?.name || 'Overview'} - {getAppName()}</title>
            </Helmet>
            <Container size={"900"} pt="xl">
                {space && hasTemplates && (
                    <SpaceTemplatesSection
                        spaceId={space.id}
                        canCreatePages={canCreatePages}
                    />
                )}
                {space && <SpaceHomeTabs/>}
            </Container>
        </>
    );
}
