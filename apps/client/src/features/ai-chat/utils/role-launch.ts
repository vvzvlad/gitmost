import type { IAiRole } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Decide what (if anything) to auto-send when an agent role card is picked
 * (issue #149). Extracted as a pure function so the three-way behavior is
 * unit-testable without mounting the chat-thread component:
 *   - autoStart=false              -> null  (bind the role only, send nothing)
 *   - autoStart=true + message     -> the trimmed custom launchMessage
 *   - autoStart=true + empty/null  -> the default fallback text
 */
export function roleLaunchMessage(
  role: Pick<IAiRole, "autoStart" | "launchMessage">,
  defaultText: string,
): string | null {
  if (!role.autoStart) return null;
  return role.launchMessage?.trim() || defaultText;
}

/**
 * Whether the "role picked but nothing sent yet" flag (`rolePickedNoSend`)
 * should reset to false. After an autoStart=false pick the thread shows the
 * composer with chatId still null; when the user then starts a fresh chat the
 * parent clears the bound role (roleId -> null) but chatId stays null, so the
 * thread never remounts and the flag would otherwise stay set — hiding the role
 * cards forever. Reset exactly in that state; a still-bound role (roleId set)
 * keeps the cards hidden. (Regression guard for #149.)
 */
export function shouldResetRolePicked(
  chatId: string | null,
  roleId: string | null | undefined,
  rolePickedNoSend: boolean,
): boolean {
  return chatId === null && roleId == null && rolePickedNoSend;
}
