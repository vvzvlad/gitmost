import { ActionIcon, Box, Button, Group, Text } from "@mantine/core";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  heatLevel,
  isoDayInTz,
} from "@/features/page-history/utils/revision-row";
import classes from "./css/history.module.css";
import clsx from "clsx";

interface CalendarCell {
  date: Date;
  dayISO: string;
  label: string;
  inMonth: boolean;
}

/** Build a Monday-first 6×7 grid for `viewYear`/`viewMonth` (0-based month).
 *  Cells are dated at local noon so `isoDayInTz` never straddles a DST midnight. */
function buildGrid(
  viewYear: number,
  viewMonth: number,
  tz: string,
): CalendarCell[] {
  const first = new Date(viewYear, viewMonth, 1, 12);
  // JS getDay(): 0=Sun..6=Sat → shift to Monday-first offset.
  const offset = (first.getDay() + 6) % 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(viewYear, viewMonth, 1 - offset + i, 12);
    cells.push({
      date,
      dayISO: isoDayInTz(date, tz),
      label: String(date.getDate()),
      inMonth: date.getMonth() === viewMonth,
    });
  }
  return cells;
}

interface Props {
  /** dayISO → total revision count for the day (heatmap intensity, #605). */
  counts: Map<string, number>;
  selectedDayISO: string | null;
  onPickDay: (dayISO: string) => void;
  tz: string;
}

/**
 * #568 — mini-calendar heatmap + date-jumper. Cell intensity = revisions that
 * day (`counts`); month navigation is purely client-side (whole history already
 * loaded). Picking a day delegates to `onPickDay(dayISO)` which scrolls/loads the
 * dense list to that day. Empty `counts` (fail-open) simply renders a blank grid.
 */
export default function MiniCalendar({
  counts,
  selectedDayISO,
  onPickDay,
  tz,
}: Props) {
  const { t } = useTranslation();
  const now = new Date();
  const [view, setView] = useState({
    year: now.getFullYear(),
    month: now.getMonth(),
  });

  const cells = useMemo(
    () => buildGrid(view.year, view.month, tz),
    [view.year, view.month, tz],
  );

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(new Date(view.year, view.month, 1)),
    [view.year, view.month],
  );

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    // 2024-01-01 is a Monday — build a Monday-first header.
    return Array.from({ length: 7 }, (_, i) =>
      fmt.format(new Date(2024, 0, 1 + i)),
    );
  }, []);

  const step = (delta: number) =>
    setView((v) => {
      const m = v.month + delta;
      return {
        year: v.year + Math.floor(m / 12),
        month: ((m % 12) + 12) % 12,
      };
    });

  return (
    <Box p="10px 12px 8px" className={classes.navFilterRow} style={{ height: "auto" }}>
      <Group gap={6} mb={6} wrap="nowrap">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={t("Previous month")}
          onClick={() => step(-1)}
        >
          <IconChevronLeft size={16} />
        </ActionIcon>
        <Text fz={12} fw={600} style={{ flex: 1, textAlign: "center" }}>
          {monthLabel}
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={t("Next month")}
          onClick={() => step(1)}
        >
          <IconChevronRight size={16} />
        </ActionIcon>
        <Button
          variant="subtle"
          size="compact-xs"
          onClick={() =>
            setView({ year: now.getFullYear(), month: now.getMonth() })
          }
        >
          {t("Today")}
        </Button>
      </Group>

      <Box style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
        {weekdays.map((w, i) => (
          <Text key={i} ta="center" fz={9} fw={600} c="dimmed">
            {w}
          </Text>
        ))}
      </Box>

      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7,1fr)",
          gap: 2,
          marginTop: 2,
        }}
      >
        {cells.map((cell) => {
          const count = counts.get(cell.dayISO) ?? 0;
          const level = cell.inMonth ? heatLevel(count) : 0;
          const selected = cell.inMonth && cell.dayISO === selectedDayISO;
          // Non-color cue (F3 a11y): the count is announced, not conveyed by the
          // heat color alone — e.g. "12 Jul: 3 revisions". The heatmap counts ALL
          // revisions (#605), so the label says "revisions", not "versions".
          const dayLabel = new Intl.DateTimeFormat(undefined, {
            timeZone: tz,
            day: "numeric",
            month: "short",
          }).format(cell.date);
          const ariaLabel = t("{{date}}: {{count}} revisions", {
            date: dayLabel,
            count,
          });
          return (
            <Box
              key={cell.dayISO}
              data-testid="calendar-day"
              data-day={cell.dayISO}
              // Only in-month cells are interactive → focusable buttons with a
              // title/aria-label and Enter/Space activation; outside cells inert.
              role={cell.inMonth ? "button" : undefined}
              tabIndex={cell.inMonth ? 0 : undefined}
              aria-label={cell.inMonth ? ariaLabel : undefined}
              aria-pressed={cell.inMonth ? selected : undefined}
              title={cell.inMonth ? ariaLabel : undefined}
              onClick={() => cell.inMonth && onPickDay(cell.dayISO)}
              onKeyDown={(e) => {
                if (cell.inMonth && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onPickDay(cell.dayISO);
                }
              }}
              className={clsx(
                classes.calDay,
                classes[`calHeat${level}` as keyof typeof classes],
                {
                  [classes.calDaySelected]: selected,
                  [classes.calDayOutside]: !cell.inMonth,
                },
              )}
            >
              {cell.label}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
