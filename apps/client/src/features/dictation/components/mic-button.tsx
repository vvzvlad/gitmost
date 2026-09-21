import { FC } from "react";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { IconMicrophone, IconPlayerStopFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useDictation } from "@/features/dictation/hooks/use-dictation";
import { useStreamingDictation } from "@/features/dictation/hooks/use-streaming-dictation";
import {
  isDictationSupported,
  resolveUnavailableLabel,
  type DictationUnavailableReason,
} from "@/features/dictation/dictation-status";
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
  // When the mic is disabled for an availability reason, this is the cause the
  // idle tooltip explains (e.g. pre-sync "connecting", "offline", "read-only").
  unavailableReason?: DictationUnavailableReason;
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
  unavailableReason,
}) => {
  const { t } = useTranslation();
  // Call BOTH hooks unconditionally to respect the rules of hooks: which one is
  // active is a render-time choice, but both must be invoked every render. This
  // is safe because both controllers are inert until start() is called — neither
  // opens the mic on mount — so the unused one costs nothing.
  const batchCtl = useDictation({ onText, onStart });
  const streamingCtl = useStreamingDictation({ onText, onStart });
  const ctl = streaming ? streamingCtl : batchCtl;
  const { status, start, stop, audioLevel, errorMessage } = ctl;
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
    // a confusing second click can't fire while the model loads. The error case
    // explains the failure via the hook's resolved errorMessage instead of the
    // transient "Transcribing…" label.
    const label =
      status === "error"
        ? (errorMessage ?? t("Transcription failed"))
        : status === "loading"
          ? t("Preparing…")
          : t("Transcribing…");
    return (
      <Tooltip label={label} withArrow>
        <ActionIcon
          size={size}
          variant="subtle"
          color={color}
          // Mark disabled the Mantine way (data-disabled/aria-disabled) rather
          // than the native `disabled` attribute: native `disabled` sets
          // `pointer-events:none`, which suppresses hover so the Tooltip never
          // fires. This is a status display with no click action to guard, so
          // keeping it hoverable simply lets the error reason be read on hover.
          data-disabled
          aria-disabled
          aria-label={label}
        >
          <Loader size="xs" />
        </ActionIcon>
      </Tooltip>
    );
  }

  // Idle branch. A grey/disabled mic must explain WHY it can't record. An
  // unsupported browser/context is detected here; otherwise the parent forwards
  // a cause-specific reason. We must NOT pass the native `disabled` prop: Mantine
  // renders `<button disabled>` with `pointer-events:none`, which suppresses
  // hover so the Tooltip never fires. Instead mark it disabled the Mantine way
  // (data-disabled/aria-disabled) — keeping it hoverable and in the a11y tree —
  // and guard the click ourselves.
  const unsupported = !isDictationSupported();
  const isDisabled = disabled || unsupported;
  const reason: DictationUnavailableReason | undefined = unsupported
    ? "unsupported"
    : unavailableReason;
  const reasonLabel = reason ? resolveUnavailableLabel(reason, t) : undefined;
  // A disabled mic with a known reason surfaces it on hover; an enabled mic
  // invites "Start dictation". But a mic disabled with NO reason (e.g. a
  // consumer that passes bare `disabled` — the AI chat's isStreaming, with no
  // unavailableReason) must NOT hover a misleading, actionable "Start dictation"
  // tooltip on a control that rejects the click. In that case we render the icon
  // without a Tooltip and give it a neutral accessible label instead.
  const ariaLabel = reasonLabel ?? (isDisabled ? t("Dictation") : t("Start dictation"));
  const icon = (
    <ActionIcon
      size={size}
      variant="subtle"
      color={color}
      onClick={(e) => {
        if (isDisabled) {
          e.preventDefault();
          return;
        }
        void start();
      }}
      data-disabled={isDisabled || undefined}
      aria-disabled={isDisabled}
      aria-label={ariaLabel}
    >
      <IconMicrophone size={resolvedIconSize} />
    </ActionIcon>
  );
  // Suppress the tooltip on a disabled mic that has nothing to explain — hovering
  // a grey, unclickable mic should not advertise "Start dictation".
  if (isDisabled && !reasonLabel) {
    return icon;
  }
  return (
    <Tooltip
      label={reasonLabel ?? t("Start dictation")}
      withArrow
    >
      {icon}
    </Tooltip>
  );
};
