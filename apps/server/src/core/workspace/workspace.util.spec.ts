import { isAdminActingOnOwner } from './workspace.util';
import { UserRole } from '../../common/helpers/types/permission';

// Pins the guard that stops an admin from demoting/deleting an owner.
// Signature: isAdminActingOnOwner(authUserRole, targetRole) — returns true ONLY
// when an admin acts on an owner. Every other combination must be false, so we
// assert the exact boolean for each pairing rather than mere truthiness.

describe('isAdminActingOnOwner', () => {
  it('returns true when an admin acts on an owner', () => {
    expect(isAdminActingOnOwner(UserRole.ADMIN, UserRole.OWNER)).toBe(true);
  });

  it('returns false when an owner acts on an owner', () => {
    expect(isAdminActingOnOwner(UserRole.OWNER, UserRole.OWNER)).toBe(false);
  });

  it('returns false when an admin acts on a member', () => {
    expect(isAdminActingOnOwner(UserRole.ADMIN, UserRole.MEMBER)).toBe(false);
  });

  it('returns false when an admin acts on another admin', () => {
    expect(isAdminActingOnOwner(UserRole.ADMIN, UserRole.ADMIN)).toBe(false);
  });

  it('returns false when a member acts on an owner', () => {
    expect(isAdminActingOnOwner(UserRole.MEMBER, UserRole.OWNER)).toBe(false);
  });
});
