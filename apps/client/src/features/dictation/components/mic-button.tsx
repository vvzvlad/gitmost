import { FC } from "react";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconMicrophone, IconPlayerStopFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import classes from "./mic-button.module.css";

interface MicButtonProps {
  onText: (text: string) => void;
  onStart?: () => void;
  disabled?: boolean;
  // Mantine ActionIcon size token; "lg" matches the chat composer, "md" the
  // editor toolbar.
  size?: "md" | "lg";
}

/**
 * Self-contained dictation toggle. Owns its own capture state machine: a click
 * starts recording (mic icon), a second click stops it (stop icon), and while
 * the audio is being transcribed it shows a spinner and is disabled to prevent
 * overlapping requests.
 */
export const MicButton: FC<MicButtonProps> = ({
  onText,
  onStart,
  disabled,
  size = "lg",
}) => {
  const { t } = useTranslation();
  const { status, start, stop, audioLevel } = useDictation({ onText, onStart });
  const reduceMotion = useReducedMotion();
  const iconSize = size === "lg" ? 18 : 16;

  if (status === "recording") {
    // Live volume-driven halo, or a static halo when the user prefers reduced motion.
    const haloScale = reduceMotion ? 1.15 : 1 + Math.min(1, audioLevel) * 0.9;
    return (
      <Tooltip label={t("Stop recording")} withArrow>
        <span className={classes.recordingWrap}>
          <span
            className={classes.pulse}
            style={{ transform: `scale(${haloScale})` }}
            aria-hidden="true"
          />
          <ActionIcon
            size={size}
            color="red"
            variant="light"
            onClick={stop}
            aria-label={t("Stop recording")}
            style={{ position: "relative", zIndex: 1 }}
          >
            <IconPlayerStopFilled size={iconSize} />
          </ActionIcon>
        </span>
      </Tooltip>
    );
  }

  if (status === "transcribing" || status === "error") {
    return (
      <Tooltip label={t("Transcribing…")} withArrow>
        <ActionIcon
          size={size}
          variant="subtle"
          disabled
          aria-label={t("Transcribing…")}
        >
          <Loader size="xs" />
        </ActionIcon>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={t("Start dictation")} withArrow>
      <ActionIcon
        size={size}
        variant="subtle"
        onClick={() => void start()}
        disabled={disabled}
        aria-label={t("Start dictation")}
      >
        <IconMicrophone size={iconSize} />
      </ActionIcon>
    </Tooltip>
  );
};
