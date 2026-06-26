import { NotFoundException } from '@nestjs/common';
import WorkspaceAbilityFactory from './workspace-ability.factory';
import { UserRole } from '../../../common/helpers/types/permission';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../interfaces/workspace-ability.type';

// Pins the workspace-level RBAC encoded by WorkspaceAbilityFactory.createForUser.
// The role arrives via the `user.role` field (a UserRole enum value); the
// workspace argument is unused by the factory, so a bare stub is enough.
//
// The CASL builders are synchronous; we exercise the REAL factory and assert on
// the resulting ability with can()/cannot() so a privilege-escalation regression
// (admin gaining audit, member gaining write access) flips an assertion.

const factory = new WorkspaceAbilityFactory();
const workspace = { id: 'w1' } as any;
const abilityFor = (role: UserRole) =>
  factory.createForUser({ id: 'u1', role } as any, workspace);

const Manage = WorkspaceCaslAction.Manage;
const Read = WorkspaceCaslAction.Read;
const Create = WorkspaceCaslAction.Create;
const { Settings, Member, Space, Group, Attachment, API, Audit } =
  WorkspaceCaslSubject;

describe('WorkspaceAbilityFactory.createForUser', () => {
  describe('OWNER', () => {
    it('can Manage Audit (owner-only capability)', () => {
      expect(abilityFor(UserRole.OWNER).can(Manage, Audit)).toBe(true);
    });

    it('can Manage Settings, Member, Space and Group', () => {
      const ability = abilityFor(UserRole.OWNER);
      expect(ability.can(Manage, Settings)).toBe(true);
      expect(ability.can(Manage, Member)).toBe(true);
      expect(ability.can(Manage, Space)).toBe(true);
      expect(ability.can(Manage, Group)).toBe(true);
    });
  });

  describe('ADMIN', () => {
    it('canNOT Manage Audit (audit is owner-only)', () => {
      const ability = abilityFor(UserRole.ADMIN);
      expect(ability.can(Manage, Audit)).toBe(false);
      expect(ability.cannot(Manage, Audit)).toBe(true);
    });

    it('canNOT Read Audit either (no audit ability at all)', () => {
      expect(abilityFor(UserRole.ADMIN).can(Read, Audit)).toBe(false);
    });

    it('can Manage Settings, Member, Space and Group', () => {
      const ability = abilityFor(UserRole.ADMIN);
      expect(ability.can(Manage, Settings)).toBe(true);
      expect(ability.can(Manage, Member)).toBe(true);
      expect(ability.can(Manage, Space)).toBe(true);
      expect(ability.can(Manage, Group)).toBe(true);
    });

    it('can Manage Attachment and API', () => {
      const ability = abilityFor(UserRole.ADMIN);
      expect(ability.can(Manage, Attachment)).toBe(true);
      expect(ability.can(Manage, API)).toBe(true);
    });
  });

  describe('MEMBER', () => {
    it('can only Read Settings, Member, Space and Group', () => {
      const ability = abilityFor(UserRole.MEMBER);
      expect(ability.can(Read, Settings)).toBe(true);
      expect(ability.can(Read, Member)).toBe(true);
      expect(ability.can(Read, Space)).toBe(true);
      expect(ability.can(Read, Group)).toBe(true);
    });

    it('canNOT Manage Settings, Member, Space or Group', () => {
      const ability = abilityFor(UserRole.MEMBER);
      expect(ability.can(Manage, Settings)).toBe(false);
      expect(ability.can(Manage, Member)).toBe(false);
      expect(ability.can(Manage, Space)).toBe(false);
      expect(ability.can(Manage, Group)).toBe(false);
    });

    it('canNOT Manage Audit', () => {
      expect(abilityFor(UserRole.MEMBER).can(Manage, Audit)).toBe(false);
    });

    it('keeps only the documented elevated grants (Manage Attachment, Create API)', () => {
      const ability = abilityFor(UserRole.MEMBER);
      // These are the deliberate exceptions to the read-only baseline.
      expect(ability.can(Manage, Attachment)).toBe(true);
      expect(ability.can(Create, API)).toBe(true);
      // ...but a member must not gain blanket Manage over API.
      expect(ability.can(Manage, API)).toBe(false);
    });
  });

  describe('invalid role', () => {
    it('throws NotFoundException for an unknown role string', () => {
      expect(() =>
        factory.createForUser({ id: 'u1', role: 'superuser' } as any, workspace),
      ).toThrow(NotFoundException);
    });

    it('throws NotFoundException when the role is undefined', () => {
      expect(() =>
        factory.createForUser({ id: 'u1', role: undefined } as any, workspace),
      ).toThrow(NotFoundException);
    });
  });
});
