import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateAgentRoleDto, RoleModelConfigDto } from './agent-role.dto';

/**
 * API-boundary validation for the role model override. The key invariants:
 *  - `driver`, when present, must be a supported server driver (AI_DRIVERS);
 *  - `chatModel`, when present, must be a non-empty, trimmed, bounded string —
 *    empty/whitespace-only garbage is rejected here, not at provider runtime.
 */
describe('RoleModelConfigDto validation', () => {
  function validateConfig(config: unknown) {
    const dto = plainToInstance(RoleModelConfigDto, config);
    return validateSync(dto as object);
  }

  it('accepts a supported driver + non-empty chatModel', () => {
    expect(validateConfig({ driver: 'openai', chatModel: 'gpt-4o' })).toHaveLength(
      0,
    );
  });

  it('accepts an empty object (omitted override => workspace default)', () => {
    expect(validateConfig({})).toHaveLength(0);
  });

  it('rejects an unknown driver', () => {
    const errors = validateConfig({ driver: 'anthropic', chatModel: 'x' });
    expect(errors.some((e) => e.property === 'driver')).toBe(true);
  });

  it('rejects an empty chatModel string', () => {
    const errors = validateConfig({ chatModel: '' });
    expect(errors.some((e) => e.property === 'chatModel')).toBe(true);
  });

  it('rejects a whitespace-only chatModel (trimmed to empty)', () => {
    const errors = validateConfig({ chatModel: '   ' });
    expect(errors.some((e) => e.property === 'chatModel')).toBe(true);
  });

  it('trims surrounding whitespace from chatModel', () => {
    const dto = plainToInstance(RoleModelConfigDto, {
      chatModel: '  gpt-4o-mini  ',
    });
    expect(validateSync(dto as object)).toHaveLength(0);
    expect(dto.chatModel).toBe('gpt-4o-mini');
  });

  it('rejects a chatModel longer than 200 chars', () => {
    const errors = validateConfig({ chatModel: 'a'.repeat(201) });
    expect(errors.some((e) => e.property === 'chatModel')).toBe(true);
  });
});

describe('CreateAgentRoleDto with nested modelConfig', () => {
  function validateCreate(payload: unknown) {
    const dto = plainToInstance(CreateAgentRoleDto, payload);
    return validateSync(dto as object);
  }

  const base = { name: 'Researcher', instructions: 'Do research.' };

  it('accepts a valid create payload with a model override', () => {
    expect(
      validateCreate({
        ...base,
        modelConfig: { driver: 'gemini', chatModel: 'gemini-2.0-flash' },
      }),
    ).toHaveLength(0);
  });

  it('rejects a create payload whose nested chatModel is blank', () => {
    const errors = validateCreate({
      ...base,
      modelConfig: { chatModel: '   ' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
