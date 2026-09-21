import { useEffect, useState } from "react";
import { Button, Group, Popover, Text } from "@mantine/core";
import { useClickOutside, useDisclosure } from "@mantine/hooks";
import { IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { parseIconRef, serializeIconRef } from "@/lib/icon-ref";
import { LucideGlyph } from "./lucide-glyph";
import { LucideIconGrid } from "./lucide-icon-grid";

export interface RoleGlyphPickerProps {
  /** Current stored value (IconRef JSON without color, a legacy emoji, or ""). */
  value: string | null | undefined;
  /** Called with the serialized IconRef JSON (name only, no color). */
  onChange: (json: string) => void;
  /** Called to clear the glyph (stores an empty value). */
  onRemove: () => void;
  label?: string;
  description?: string;
}

/**
 * The role-glyph picker: a Popover trigger showing the current Lucide glyph (or
 * a sparkles placeholder) that opens the {@link LucideIconGrid} — GRID ONLY, no
 * color palette (a role avatar's background is a name-hashed gradient). On pick
 * it stores `{"name":...}`.
 */
export function RoleGlyphPicker({
  value,
  onChange,
  onRemove,
  label,
  description,
}: RoleGlyphPickerProps) {
  const { t } = useTranslation();
  const [opened, handlers] = useDisclosure(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);

  useClickOutside(
    () => handlers.close(),
    ["mousedown", "touchstart"],
    [dropdown, target],
  );

  useEffect(() => {
    if (!opened) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        handlers.close();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [opened, handlers]);

  const name = parseIconRef(value)?.name;

  const handlePick = (picked: string) => {
    onChange(serializeIconRef({ name: picked }));
    handlers.close();
  };

  const handleRemove = () => {
    onRemove();
    handlers.close();
  };

  return (
    <div>
      {label && (
        <Text size="sm" fw={500} mb={2}>
          {label}
        </Text>
      )}
      {description && (
        <Text size="xs" c="dimmed" mb={6}>
          {description}
        </Text>
      )}
      <Popover
        opened={opened}
        onClose={handlers.close}
        width={332}
        position="bottom-start"
        closeOnEscape
      >
        <Popover.Target ref={setTarget}>
          <Button
            type="button"
            variant="default"
            onClick={handlers.toggle}
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-label={t("Pick icon")}
            leftSection={
              <LucideGlyph
                name={name}
                size={18}
                fallback={<IconSparkles size={18} />}
              />
            }
          >
            {name ?? t("Choose icon")}
          </Button>
        </Popover.Target>
        <Popover.Dropdown ref={setDropdown} p="sm">
          {opened && (
            <>
              <LucideIconGrid onPick={handlePick} />
              <Group justify="flex-end" mt="xs">
                <Button
                  variant="default"
                  c="gray"
                  size="xs"
                  onClick={handleRemove}
                >
                  {t("Remove")}
                </Button>
              </Group>
            </>
          )}
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

export default RoleGlyphPicker;
