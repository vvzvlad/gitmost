import {
  ActionIcon,
  Button,
  ColorInput,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { SpaceIcon } from "./space-icon";
import { SPACE_ICONS, SPACE_ICON_COLORS } from "./space-icon-options";

interface Props {
  name: string;
  logo?: string;
  icon: string;
  color: string;
  onIconChange: (icon: string) => void;
  onColorChange: (color: string) => void;
  readOnly?: boolean;
  error?: React.ReactNode;
}
export function SpaceAppearancePicker({
  name,
  logo,
  icon,
  color,
  onIconChange,
  onColorChange,
  readOnly,
  error,
}: Props) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <Text size="sm" fw={500}>
        {t("Space appearance")}
      </Text>
      <Group wrap="nowrap">
        <SpaceIcon
          space={{ name, logo, settings: { appearance: { icon, color } } }}
          size={48}
        />
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {name || t("Space name")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Shown in navigation and space lists")}
          </Text>
        </div>
      </Group>
      <SimpleGrid
        cols={{ base: 6, sm: 8 }}
        spacing={6}
        role="group"
        aria-label={t("Space icon")}
      >
        {SPACE_ICONS.map((option) => (
          <Tooltip key={option.value} label={t(option.label)}>
            <ActionIcon
              type="button"
              size="lg"
              variant={icon === option.value ? "light" : "subtle"}
              aria-label={t(option.label)}
              aria-pressed={icon === option.value}
              disabled={readOnly}
              onClick={() => onIconChange(option.value)}
            >
              <option.component size={22} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        ))}
      </SimpleGrid>
      <ColorInput
        label={t("Icon color")}
        value={color}
        onChange={onColorChange}
        format="hex"
        swatches={SPACE_ICON_COLORS}
        placeholder="#166c9d"
        disabled={readOnly}
        error={error}
        withEyeDropper={false}
      />
      <Button
        type="button"
        variant="subtle"
        size="xs"
        w="fit-content"
        disabled={readOnly || (!icon && !color)}
        onClick={() => {
          onIconChange("");
          onColorChange("");
        }}
      >
        {t("Reset space appearance")}
      </Button>
    </Stack>
  );
}
