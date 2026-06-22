import { FC } from "react";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { IconMicrophone, IconPlayerStopFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { useStreamingDictation } from "@/features/dictation/hooks/use-streaming-dictation";
import classes from "./mic-button.module.css";

interface MicButtonProps {
  onText: (text: string) => void;
  onStart?: () => void;
  disabled?: boolean;
  // Mantine ActionIcon size token; "lg" matches the chat composer, "md" the
  // editor toolbar.
  size?: "md" | "lg";
  // Optional Mantine color override for the idle/transcribing states (the
  // recording state stays red). Defaults to the theme primary when omitted.
  color?: string;
  // Optional explicit glyph size override; defaults to the size-token value.
  iconSize?: number;
  // When true, use the streaming (Silero-VAD) dictation controller, which emits
  // text progressively as the user pauses; otherwise use the batch controller.
  streaming?: boolean;
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
  color,
  iconSize,
  streaming = false,
}) => {
  const { t } = useTranslation();
  // Call BOTH hooks unconditionally to respect the rules of hooks: which one is
  // active is a render-time choice, but both must be invoked every render. This
  // is safe because both controllers are inert until start() is called — neither
  // opens the mic on mount — so the unused one costs nothing.
  const batchCtl = useDictation({ onText, onStart });
  const streamingCtl = useStreamingDictation({ onText, onStart });
  const ctl = streaming ? streamingCtl : batchCtl;
  const { status, start, stop, audioLevel } = ctl;
  const resolvedIconSize = iconSize ?? (size === "lg" ? 18 : 16);

  if (status === "recording") {
    // Live volume-driven halo: the scale follows the current mic level.
    const haloScale = 1 + Math.min(1, audioLevel) * 0.9;
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
            <IconPlayerStopFilled size={resolvedIconSize} />
          </ActionIcon>
        </span>
      </Tooltip>
    );
  }

  if (
    status === "loading" ||
    status === "transcribing" ||
    status === "error"
  ) {
    // "loading" (streaming hook fetching the VAD model on first use) shows the
    // same spinner+disabled state so the first click is visibly acknowledged and
    // a confusing second click can't fire while the model loads.
    const label = status === "loading" ? t("Preparing…") : t("Transcribing…");
    return (
      <Tooltip label={label} withArrow>
        <ActionIcon
          size={size}
          variant="subtle"
          color={color}
          disabled
          aria-label={label}
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
        color={color}
        onClick={() => void start()}
        disabled={disabled}
        aria-label={t("Start dictation")}
      >
        <IconMicrophone size={resolvedIconSize} />
      </ActionIcon>
    </Tooltip>
  );
};
