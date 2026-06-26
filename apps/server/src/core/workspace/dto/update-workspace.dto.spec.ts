import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateWorkspaceDto } from './update-workspace.dto';

// API-boundary validation for the two html-embed/tracker settings fields:
//  - trackerHead: optional string, max 20000 chars (admin-authored snippet);
//  - htmlEmbed: optional boolean (workspace master toggle).
// All other fields are optional, so a payload carrying just the field under test
// isolates that field's constraints.

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateWorkspaceDto, payload);
  return validate(dto as object);
}

function hasError(errors: any[], property: string, constraint?: string) {
  const err = errors.find((e) => e.property === property);
  if (!err) return false;
  if (!constraint) return true;
  return Object.keys(err.constraints ?? {}).includes(constraint);
}

describe('UpdateWorkspaceDto.trackerHead validation', () => {
  it('accepts a normal trackerHead string', async () => {
    const errors = await validateDto({ trackerHead: '<script>ga()</script>' });
    expect(hasError(errors, 'trackerHead')).toBe(false);
  });

  it('accepts exactly 20000 characters', async () => {
    const errors = await validateDto({ trackerHead: 'a'.repeat(20000) });
    expect(hasError(errors, 'trackerHead')).toBe(false);
  });

  it('rejects 20001 characters with a maxLength error', async () => {
    const errors = await validateDto({ trackerHead: 'a'.repeat(20001) });
    expect(hasError(errors, 'trackerHead', 'maxLength')).toBe(true);
  });

  it('rejects a non-string trackerHead with an isString error', async () => {
    const errors = await validateDto({ trackerHead: 123 });
    expect(hasError(errors, 'trackerHead', 'isString')).toBe(true);
  });

  it('accepts an omitted trackerHead (optional)', async () => {
    const errors = await validateDto({});
    expect(hasError(errors, 'trackerHead')).toBe(false);
  });
});

describe('UpdateWorkspaceDto.htmlEmbed validation', () => {
  it('accepts htmlEmbed: true', async () => {
    const errors = await validateDto({ htmlEmbed: true });
    expect(hasError(errors, 'htmlEmbed')).toBe(false);
  });

  it('accepts htmlEmbed: false', async () => {
    const errors = await validateDto({ htmlEmbed: false });
    expect(hasError(errors, 'htmlEmbed')).toBe(false);
  });

  it('rejects a non-boolean htmlEmbed with an isBoolean error', async () => {
    const errors = await validateDto({ htmlEmbed: 'yes' });
    expect(hasError(errors, 'htmlEmbed', 'isBoolean')).toBe(true);
  });
});
