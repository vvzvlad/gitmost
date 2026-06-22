import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWorkspaceDto } from './create-workspace.dto';
import { UpdateWorkspaceDto } from './update-workspace.dto';

// API-boundary validation for the workspace `name` field. The name is:
//  - required, 1..64 chars (MinLength/MaxLength), trimmed on input;
//  - rejected by @NoUrls when it contains a URL or a bare domain name.
// UpdateWorkspaceDto extends CreateWorkspaceDto via PartialType, so `name`
// stays optional there but inherits the same constraints when present.

async function validateCreate(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateWorkspaceDto, payload);
  return validate(dto as object);
}

async function validateUpdate(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateWorkspaceDto, payload);
  return validate(dto as object);
}

function hasError(errors: any[], property: string, constraint?: string) {
  const err = errors.find((e) => e.property === property);
  if (!err) return false;
  if (!constraint) return true;
  return Object.keys(err.constraints ?? {}).includes(constraint);
}

describe('CreateWorkspaceDto.name validation', () => {
  it('accepts a plain workspace name', async () => {
    const errors = await validateCreate({ name: 'My Workspace' });
    expect(hasError(errors, 'name')).toBe(false);
  });

  it('rejects a name containing a URL with the noUrls error', async () => {
    const errors = await validateCreate({
      name: 'Visit https://evil.com now',
    });
    expect(hasError(errors, 'name', 'noUrls')).toBe(true);
  });

  it('rejects a name containing a bare domain with the noUrls error', async () => {
    const errors = await validateCreate({ name: 'evil.com workspace' });
    expect(hasError(errors, 'name', 'noUrls')).toBe(true);
  });

  it('rejects an empty name with a minLength error', async () => {
    const errors = await validateCreate({ name: '' });
    expect(hasError(errors, 'name', 'minLength')).toBe(true);
  });

  it('accepts exactly 64 characters', async () => {
    const errors = await validateCreate({ name: 'a'.repeat(64) });
    expect(hasError(errors, 'name')).toBe(false);
  });

  it('rejects 65 characters with a maxLength error', async () => {
    const errors = await validateCreate({ name: 'a'.repeat(65) });
    expect(hasError(errors, 'name', 'maxLength')).toBe(true);
  });
});

describe('UpdateWorkspaceDto.name validation (inherited)', () => {
  it('accepts a plain workspace name', async () => {
    const errors = await validateUpdate({ name: 'My Workspace' });
    expect(hasError(errors, 'name')).toBe(false);
  });

  it('rejects a name containing a URL with the noUrls error', async () => {
    const errors = await validateUpdate({
      name: 'Visit https://evil.com now',
    });
    expect(hasError(errors, 'name', 'noUrls')).toBe(true);
  });

  it('accepts an omitted name (optional via PartialType)', async () => {
    const errors = await validateUpdate({});
    expect(hasError(errors, 'name')).toBe(false);
  });
});
