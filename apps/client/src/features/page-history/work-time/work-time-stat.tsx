import { Modal, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconClockHour4 } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { usePageWorkTime } from "./use-page-work-time";
import { formatGapMinutes, formatHeadline } from "./format-work-time";
import WorkTimePunchCard from "./work-time-punch-card";

interface Props {
  pageId: string;
}

/**
 * #395 — the clickable "time worked on this article" headline (§6.1). Renders
 * the `work` estimate with a "≈" sign and the inactivity threshold in a tooltip
 * (it is an estimate, not a stopwatch). Clicking opens the daily punch-card
 * (§6.2). Renders nothing until there is a non-zero human OR agent estimate, so a
 * brand-new / never-edited page shows no widget. For an agent-only-edited page
 * (workMs===0, agentOnlyMs>0) the headline shows the agent estimate (labelled
 * `agent:`, matching the punch-card) so the punch-card stays reachable (#395:
 * "how much a HUMAN and separately the AGENT").
 */
export default function WorkTimeStat({ pageId }: Props) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const { data } = usePageWorkTime(pageId);

  if (!data || (data.workMs <= 0 && data.agentOnlyMs <= 0)) return null;

  const agentOnly = data.workMs <= 0;
  const label = agentOnly
    ? t("agent: {{value}}", { value: formatHeadline(data.agentOnlyMs, t) })
    : formatHeadline(data.workMs, t);
  const gapMin = formatGapMinutes(data.config.tGap);

  return (
    <>
      <Tooltip
        label={t("Estimated time worked (inactivity gap {{gap}} min)", {
          gap: gapMin,
        })}
        position="bottom"
      >
        <UnstyledButton
          onClick={open}
          aria-label={t("Show time worked on this page")}
        >
          <Text
            size="xs"
            c="dimmed"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <IconClockHour4 size={14} />
            {label}
          </Text>
        </UnstyledButton>
      </Tooltip>

      <Modal
        opened={opened}
        onClose={close}
        title={t("Time worked on this article")}
        size="46rem"
      >
        <WorkTimePunchCard data={data} />
      </Modal>
    </>
  );
}
