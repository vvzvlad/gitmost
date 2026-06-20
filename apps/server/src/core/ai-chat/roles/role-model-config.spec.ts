import { roleModelOverride } from './role-model-config';
import type { AiAgentRole } from '@docmost/db/types/entity.types';

/**
 * Unit tests for roleModelOverride: the pure validator that turns a role's
 * persisted `model_config` into a ChatModelOverride for AiService.getChatModel,
 * or undefined when there is no usable override.
 *
 * The security-relevant invariant: an UNKNOWN driver value must be DROPPED (not
 * forwarded), because getChatModel's switch default throws — a garbage driver
 * would otherwise break the turn instead of falling back to the workspace model.
 */
describe('roleModelOverride', () => {
  function role(modelConfig: unknown, name = 'Researcher'): AiAgentRole {
    return { id: 'r1', name, modelConfig } as unknown as AiAgentRole;
  }

  it('null role => undefined', () => {
    expect(roleModelOverride(null)).toBeUndefined();
    expect(roleModelOverride(undefined)).toBeUndefined();
  });

  it('modelConfig=null => undefined (no override)', () => {
    expect(roleModelOverride(role(null))).toBeUndefined();
  });

  it("unknown driver 'foo' + chatModel => override with chatModel + roleName but NO driver", () => {
    const out = roleModelOverride(role({ driver: 'foo', chatModel: 'gpt-x' }));
    // The garbage driver must NOT be forwarded (getChatModel's switch default
    // throws); the model id + role name still produce a valid override.
    expect(out).toEqual({
      driver: undefined,
      chatModel: 'gpt-x',
      roleName: 'Researcher',
    });
    expect(out?.driver).toBeUndefined();
  });

  it('valid { driver: gemini, chatModel } => full override with roleName', () => {
    const out = roleModelOverride(
      role({ driver: 'gemini', chatModel: 'gemini-2.0-flash' }),
    );
    expect(out).toEqual({
      driver: 'gemini',
      chatModel: 'gemini-2.0-flash',
      roleName: 'Researcher',
    });
  });

  it('blank chatModel is ignored; unknown driver with no chatModel => undefined', () => {
    // driver 'foo' is dropped and chatModel is blank => nothing usable left.
    expect(
      roleModelOverride(role({ driver: 'foo', chatModel: '   ' })),
    ).toBeUndefined();
  });

  it('blank chatModel with a valid driver => override keeps the driver, drops chatModel', () => {
    const out = roleModelOverride(role({ driver: 'openai', chatModel: '  ' }));
    expect(out).toEqual({
      driver: 'openai',
      chatModel: undefined,
      roleName: 'Researcher',
    });
  });
});
