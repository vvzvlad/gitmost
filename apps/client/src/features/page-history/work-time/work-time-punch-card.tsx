// #566 — redesigned "Time worked" body: daily time-of-day timelines. Each day is
// a 24h track showing WHEN the work happened — a sticky 00/06/12/18/24 hour axis,
// shaded night hours, per-block hover tooltip ("start – end · duration"), and a
// "now" boundary on today's row. Presentation ported from NewDesign/TimeWorkedModal;
// all data comes through the pure adapter over the real IPageWorkTime (zero backend
// change). Positioning math, empty-run collapsing and the formatters are reused.
import { Box, Group, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { IPageWorkTime } from "./work-time.types";
import { formatGapMinutes } from "./format-work-time";
import {
  buildRows,
  formatBlockTooltip,
  summaryLabels,
  TimelineBlock,
  TimelineDay,
} from "./work-time-adapter";
import classes from "./work-time.module.css";

// Minimum visible width so a very short session neither vanishes nor fakes dense
// work (§6.2); kept from the original punch-card.
const MIN_BLOCK_WIDTH_PCT = 0.6;

function ActivityBlock({
  block,
  tz,
  locale,
}: {
  block: TimelineBlock;
  tz: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const left = (block.start / 24) * 100;
  const width = Math.max(((block.end - block.start) / 24) * 100, MIN_BLOCK_WIDTH_PCT);
  const cls = [
    classes.window,
    block.kind === "work" ? classes.windowWork : classes.windowAgent,
  ].join(" ");
  return (
    <Tooltip
      label={formatBlockTooltip(block, tz, locale, t)}
      withArrow
      openDelay={120}
      fz={11}
    >
      <div className={cls} style={{ left: `${left}%`, width: `${width}%` }} />
    </Tooltip>
  );
}

function DayTrack({
  day,
  tz,
  locale,
}: {
  day: TimelineDay;
  tz: string;
  locale: string;
}) {
  return (
    <div className={classes.row}>
      <span className={classes.dayLabel}>{day.label}</span>
      <div className={`${classes.track} ${day.isEmpty ? classes.trackEmpty : ""}`}>
        {[25, 50, 75].map((p) => (
          <div key={p} className={classes.hourTick} style={{ left: `${p}%` }} />
        ))}
        {day.blocks.map((b, i) => (
          <ActivityBlock key={i} block={b} tz={tz} locale={locale} />
        ))}
        {day.isToday && day.nowFraction != null && (
          <div
            className={classes.nowLine}
            style={{ left: `${day.nowFraction * 100}%` }}
          />
        )}
      </div>
      <span
        className={classes.daySum}
        data-empty={day.totalLabel === "—" ? true : undefined}
      >
        {day.totalLabel}
      </span>
    </div>
  );
}

interface Props {
  data: IPageWorkTime;
}

export default function WorkTimePunchCard({ data }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const now = Date.now();
  const rows = useMemo(
    () => buildRows(data.perDay, t, now),
    // `now` intentionally re-read on each open; excluded so the memo tracks data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.perDay, t],
  );
  const { total, agent } = summaryLabels(data, t);
  const gapMin = formatGapMinutes(data.config.tGap);

  if (data.workMs <= 0 && data.agentOnlyMs <= 0) {
    return (
      <Text size="sm" c="dimmed" py="md">
        {t("No editing activity recorded yet.")}
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      {/* summary */}
      <Group align="baseline" gap="md">
        <Text fz={22} fw={700}>
          {total}
        </Text>
        {agent && (
          <Text size="xs" c="dimmed">
            {t("agent: {{value}}", { value: agent })}
          </Text>
        )}
      </Group>

      {/* legend */}
      <Group gap="md">
        <Text size="xs" c="dimmed">
          <span
            className={`${classes.legendSwatch} ${classes.windowWork}`}
            style={{ marginRight: 4 }}
          />
          {t("Work")}
        </Text>
        <Text size="xs" c="dimmed">
          <span
            className={`${classes.legendSwatch} ${classes.windowAgent}`}
            style={{ marginRight: 4 }}
          />
          {t("Agent")}
        </Text>
      </Group>

      {/* sticky hour axis */}
      <div className={`${classes.row} ${classes.axisRow}`}>
        <span />
        <div className={classes.axis}>
          {[
            ["0%", "00", "start"],
            ["25%", "06", "center"],
            ["50%", "12", "center"],
            ["75%", "18", "center"],
            ["100%", "24", "end"],
          ].map(([l, label, align]) => (
            <span
              key={label}
              className={classes.axisTick}
              data-align={align}
              style={{ left: l }}
            >
              {label}
            </span>
          ))}
        </div>
        <span />
      </div>

      {/* day rows */}
      <ScrollArea.Autosize mah="60vh" type="hover">
        {rows.map((row, i) =>
          row.type === "day" ? (
            <DayTrack
              key={row.day.key}
              day={row.day}
              tz={data.tz}
              locale={locale}
            />
          ) : (
            <Box key={`gap-${i}`} className={classes.gapRow}>
              {t("× {{count}} days without edits", { count: row.count })}
            </Box>
          ),
        )}
      </ScrollArea.Autosize>

      <Text size="xs" c="dimmed" mt="xs">
        {t("Estimate · timezone {{tz}} · inactivity gap {{gap}} min", {
          tz: data.tz,
          gap: gapMin,
        })}
      </Text>
    </Stack>
  );
}
