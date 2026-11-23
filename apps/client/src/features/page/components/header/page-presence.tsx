import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import {
  Group,
  Popover,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { collabProviderAtom } from "@/features/editor/atoms/editor-atoms";
import {
  collectParticipants,
  type PageParticipant,
} from "@/features/editor/page-presence";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import classes from "./page-header.module.css";

export default function PagePresence({ pageId }: { pageId?: string }) {
  const { t } = useTranslation();
  const provider = useAtomValue(collabProviderAtom);
  const [snapshot, setSnapshot] = useState<{
    provider: typeof provider;
    people: PageParticipant[];
  }>({ provider: null, people: [] });
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!provider || !awareness) return;
    const update = () => {
      setConnected(
        provider.configuration.websocketProvider.status === "connected",
      );
      const people = collectParticipants(awareness.getStates().values());
      setSnapshot((previous) =>
        previous.provider === provider &&
        JSON.stringify(previous.people) === JSON.stringify(people)
          ? previous
          : { provider, people },
      );
    };
    awareness.on("change", update);
    provider.on("status", update);
    update();
    return () => {
      awareness.off("change", update);
      provider.off("status", update);
    };
  }, [provider]);
  const people =
    connected &&
    snapshot.provider === provider &&
    provider?.configuration.name === `page.${pageId}`
      ? snapshot.people
      : [];
  if (!people.length) return null;
  const label = (person: PageParticipant) =>
    `${person.name} — ${t(person.mode === "editing" ? "Editing" : "Viewing")}`;
  return (
    <Popover position="bottom-end" shadow="md" withinPortal>
      <Popover.Target>
        <UnstyledButton
          className={classes.presenceTrigger}
          aria-label={t("People on this page")}
        >
          <Group gap={4} wrap="nowrap">
            {people.slice(0, 3).map((person) => (
              <Tooltip key={person.id} label={label(person)}>
                <span
                  className={classes.presenceAvatar}
                  style={{ borderColor: person.color }}
                >
                  <CustomAvatar
                    name={person.name}
                    avatarUrl={person.avatarUrl}
                    size={26}
                  />
                </span>
              </Tooltip>
            ))}
            {people.length > 3 && (
              <Text size="xs" visibleFrom="sm">
                +{people.length - 3}
              </Text>
            )}
            {people.length > 1 && (
              <Text size="xs" hiddenFrom="sm">
                +{people.length - 1}
              </Text>
            )}
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown maw="calc(100vw - 24px)">
        <Text fw={600} size="sm" mb="sm">
          {t("People on this page")}
        </Text>
        <Stack gap="sm" mah={300} style={{ overflowY: "auto" }}>
          {people.map((person) => (
            <Group
              key={person.id}
              gap="xs"
              wrap="nowrap"
              data-presence-user={person.id}
            >
              <span
                className={classes.presenceAvatar}
                style={{ borderColor: person.color }}
              >
                <CustomAvatar
                  name={person.name}
                  avatarUrl={person.avatarUrl}
                  size={26}
                />
              </span>
              <div style={{ minWidth: 0 }}>
                <Text size="sm" truncate maw={220}>
                  {person.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(person.mode === "editing" ? "Editing" : "Viewing")}
                </Text>
              </div>
            </Group>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
