import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PROVIDER_SETTINGS_KEYS } from './ai.types';
import { AI_PROVIDER_SETTINGS_ALLOWED } from '@docmost/db/repos/workspace/workspace.repo';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';

/**
 * Drift guard: the writable provider-settings keys are maintained in two layers
 * that TypeScript cannot cross-check — PROVIDER_SETTINGS_KEYS (ai.types, used by
 * the settings service) and AI_PROVIDER_SETTINGS_ALLOWED (the generic workspace
 * repo's SQL boundary). A key missing from the repo copy silently drops the field
 * on persist (exactly what happened to chatApiStyle), so this asserts they match.
 */
describe('provider-settings key allowlist parity', () => {
  it('the repo SQL allowlist equals PROVIDER_SETTINGS_KEYS', () => {
    expect([...AI_PROVIDER_SETTINGS_ALLOWED].sort()).toEqual(
      [...PROVIDER_SETTINGS_KEYS].sort(),
    );
  });
});

/** DTO validation for the new chatApiStyle field (@IsIn(CHAT_API_STYLES)). */
describe('UpdateAiSettingsDto.chatApiStyle', () => {
  const errorsFor = async (chatApiStyle: unknown) =>
    validate(plainToInstance(UpdateAiSettingsDto, { chatApiStyle }));

  it('accepts both valid values', async () => {
    for (const v of ['openai-compatible', 'openai']) {
      const errs = await errorsFor(v);
      expect(errs.find((e) => e.property === 'chatApiStyle')).toBeUndefined();
    }
  });

  it('rejects an unknown value', async () => {
    const errs = await errorsFor('definitely-not-a-style');
    expect(errs.find((e) => e.property === 'chatApiStyle')).toBeDefined();
  });

  it('accepts the field being omitted (optional)', async () => {
    const errs = await validate(plainToInstance(UpdateAiSettingsDto, {}));
    expect(errs.find((e) => e.property === 'chatApiStyle')).toBeUndefined();
  });
});
