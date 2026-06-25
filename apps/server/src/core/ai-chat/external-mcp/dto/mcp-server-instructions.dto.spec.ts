import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateMcpServerDto } from './create-mcp-server.dto';
import { UpdateMcpServerDto } from './update-mcp-server.dto';

/**
 * API-boundary validation for the per-server `instructions` field (#180): a free
 * text guide injected into the agent system prompt. It is optional, must be a
 * string, and is bounded by @MaxLength(4000) to cap prompt/token size.
 */
describe('MCP server DTO instructions validation', () => {
  function validateCreate(payload: unknown) {
    const dto = plainToInstance(CreateMcpServerDto, payload);
    return validateSync(dto as object);
  }
  function validateUpdate(payload: unknown) {
    const dto = plainToInstance(UpdateMcpServerDto, payload);
    return validateSync(dto as object);
  }

  const base = {
    name: 'Tavily',
    transport: 'http',
    url: 'https://example.com/mcp',
  };

  it('accepts an omitted instructions field on create', () => {
    expect(validateCreate({ ...base })).toHaveLength(0);
  });

  it('accepts a reasonable instructions string on create', () => {
    expect(
      validateCreate({ ...base, instructions: 'Use search for fresh facts.' }),
    ).toHaveLength(0);
  });

  it('rejects instructions over MaxLength(4000) on create', () => {
    const errors = validateCreate({
      ...base,
      instructions: 'a'.repeat(4001),
    });
    expect(
      errors.some(
        (e) =>
          e.property === 'instructions' &&
          e.constraints !== undefined &&
          'maxLength' in e.constraints,
      ),
    ).toBe(true);
  });

  it('accepts instructions of exactly 4000 chars on create', () => {
    expect(
      validateCreate({ ...base, instructions: 'a'.repeat(4000) }),
    ).toHaveLength(0);
  });

  it('rejects a non-string instructions value', () => {
    const errors = validateCreate({ ...base, instructions: 123 });
    expect(errors.some((e) => e.property === 'instructions')).toBe(true);
  });

  it('rejects instructions over MaxLength(4000) on update', () => {
    const errors = validateUpdate({ instructions: 'a'.repeat(4001) });
    expect(
      errors.some(
        (e) =>
          e.property === 'instructions' &&
          e.constraints !== undefined &&
          'maxLength' in e.constraints,
      ),
    ).toBe(true);
  });
});
