import { AiAgentRole } from '@docmost/db/types/entity.types';
import { AI_DRIVERS, AiDriver } from '../../../integrations/ai/ai.types';
import { ChatModelOverride } from '../../../integrations/ai/ai.service';

/**
 * Raw shape stored in `ai_agent_roles.model_config` (jsonb). Both fields are
 * optional: `{ chatModel }` swaps just the model id; `{ driver, chatModel }`
 * also switches the provider. Anything else / null => no override.
 */
export interface RoleModelConfig {
  driver?: AiDriver;
  chatModel?: string;
}

/**
 * Validate + normalize a role's persisted `model_config` into a
 * `ChatModelOverride` for `AiService.getChatModel`, or undefined when there is
 * no usable override. Unknown drivers are dropped (defensive — the create/update
 * path already validates), and a blank chatModel is ignored.
 */
export function roleModelOverride(
  role: AiAgentRole | null | undefined,
): ChatModelOverride | undefined {
  if (!role) return undefined;
  const cfg = (role.modelConfig ?? null) as RoleModelConfig | null;
  if (!cfg || typeof cfg !== 'object') return undefined;

  const driver =
    typeof cfg.driver === 'string' && AI_DRIVERS.includes(cfg.driver)
      ? cfg.driver
      : undefined;
  const chatModel =
    typeof cfg.chatModel === 'string' && cfg.chatModel.trim().length > 0
      ? cfg.chatModel.trim()
      : undefined;

  if (!driver && !chatModel) return undefined;
  return { driver, chatModel, roleName: role.name };
}
