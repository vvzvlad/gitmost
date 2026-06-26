import { findHighestUserSpaceRole } from './utils';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { UserSpaceRole } from './types';

// Pins the space-role precedence used by SpaceAbilityFactory: ADMIN (3) >
// WRITER (2) > READER (1). A precedence inversion would let a writer/reader be
// resolved as the highest role and silently gain admin/writer abilities, so we
// assert the exact winning role for mixed inputs regardless of array order.

const role = (r: SpaceRole): UserSpaceRole => ({ userId: 'u1', role: r });

describe('findHighestUserSpaceRole', () => {
  it('returns ADMIN as the highest among reader, admin, writer', () => {
    const roles = [
      role(SpaceRole.READER),
      role(SpaceRole.ADMIN),
      role(SpaceRole.WRITER),
    ];

    expect(findHighestUserSpaceRole(roles)).toBe(SpaceRole.ADMIN);
  });

  it('returns WRITER over READER', () => {
    const roles = [role(SpaceRole.READER), role(SpaceRole.WRITER)];

    expect(findHighestUserSpaceRole(roles)).toBe(SpaceRole.WRITER);
  });

  it('is independent of array order (admin last still wins)', () => {
    const roles = [role(SpaceRole.WRITER), role(SpaceRole.ADMIN)];

    expect(findHighestUserSpaceRole(roles)).toBe(SpaceRole.ADMIN);
  });

  it('returns the only role when a single membership is present', () => {
    expect(findHighestUserSpaceRole([role(SpaceRole.READER)])).toBe(
      SpaceRole.READER,
    );
    expect(findHighestUserSpaceRole([role(SpaceRole.WRITER)])).toBe(
      SpaceRole.WRITER,
    );
    expect(findHighestUserSpaceRole([role(SpaceRole.ADMIN)])).toBe(
      SpaceRole.ADMIN,
    );
  });

  it('returns undefined for an empty array (no membership)', () => {
    expect(findHighestUserSpaceRole([])).toBeUndefined();
  });

  it('returns undefined when given null', () => {
    expect(findHighestUserSpaceRole(null as any)).toBeUndefined();
  });

  it('returns undefined when given undefined', () => {
    expect(findHighestUserSpaceRole(undefined as any)).toBeUndefined();
  });
});
