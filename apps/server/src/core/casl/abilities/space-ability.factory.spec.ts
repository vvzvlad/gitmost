import { NotFoundException } from '@nestjs/common';
import SpaceAbilityFactory from './space-ability.factory';
import { SpaceRole } from '../../../common/helpers/types/permission';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../interfaces/space-ability.type';

// Pins the space-level RBAC encoded by SpaceAbilityFactory.createForUser.
// The factory derives the role from spaceMemberRepo.getUserSpaceRoles() — the
// ONLY async dependency — which returns an array of { userId, role }. We stub
// that single repo call and run the REAL CASL builders so a writer/reader
// escalation, or a non-member gaining reader rights, flips an assertion.

const Manage = SpaceCaslAction.Manage;
const Read = SpaceCaslAction.Read;
const { Settings, Member, Page, Share } = SpaceCaslSubject;

// Build a factory whose getUserSpaceRoles resolves to the given roles array.
function factoryReturning(roles: Array<{ userId: string; role: string }>) {
  const getUserSpaceRoles = jest.fn().mockResolvedValue(roles);
  const spaceMemberRepo = { getUserSpaceRoles } as any;
  return {
    factory: new SpaceAbilityFactory(spaceMemberRepo),
    getUserSpaceRoles,
  };
}

const user = { id: 'u1' } as any;
const spaceId = 's1';

describe('SpaceAbilityFactory.createForUser', () => {
  it('passes the user id and space id through to the repo lookup', async () => {
    const { factory, getUserSpaceRoles } = factoryReturning([
      { userId: 'u1', role: SpaceRole.ADMIN },
    ]);

    await factory.createForUser(user, spaceId);

    expect(getUserSpaceRoles).toHaveBeenCalledWith('u1', 's1');
  });

  describe('ADMIN', () => {
    it('can Manage Settings, Member, Page and Share', async () => {
      const { factory } = factoryReturning([
        { userId: 'u1', role: SpaceRole.ADMIN },
      ]);

      const ability = await factory.createForUser(user, spaceId);

      expect(ability.can(Manage, Settings)).toBe(true);
      expect(ability.can(Manage, Member)).toBe(true);
      expect(ability.can(Manage, Page)).toBe(true);
      expect(ability.can(Manage, Share)).toBe(true);
    });
  });

  describe('WRITER', () => {
    it('can Manage Page and Share', async () => {
      const { factory } = factoryReturning([
        { userId: 'u1', role: SpaceRole.WRITER },
      ]);

      const ability = await factory.createForUser(user, spaceId);

      expect(ability.can(Manage, Page)).toBe(true);
      expect(ability.can(Manage, Share)).toBe(true);
    });

    it('can only Read Settings and Member, never Manage them', async () => {
      const { factory } = factoryReturning([
        { userId: 'u1', role: SpaceRole.WRITER },
      ]);

      const ability = await factory.createForUser(user, spaceId);

      expect(ability.can(Read, Settings)).toBe(true);
      expect(ability.can(Read, Member)).toBe(true);
      expect(ability.can(Manage, Settings)).toBe(false);
      expect(ability.can(Manage, Member)).toBe(false);
    });
  });

  describe('READER', () => {
    it('can Read every subject', async () => {
      const { factory } = factoryReturning([
        { userId: 'u1', role: SpaceRole.READER },
      ]);

      const ability = await factory.createForUser(user, spaceId);

      expect(ability.can(Read, Settings)).toBe(true);
      expect(ability.can(Read, Member)).toBe(true);
      expect(ability.can(Read, Page)).toBe(true);
      expect(ability.can(Read, Share)).toBe(true);
    });

    it('canNOT Manage anything (read-only, no page or share writes)', async () => {
      const { factory } = factoryReturning([
        { userId: 'u1', role: SpaceRole.READER },
      ]);

      const ability = await factory.createForUser(user, spaceId);

      expect(ability.can(Manage, Settings)).toBe(false);
      expect(ability.can(Manage, Member)).toBe(false);
      expect(ability.can(Manage, Page)).toBe(false);
      expect(ability.can(Manage, Share)).toBe(false);
    });
  });

  describe('no membership', () => {
    it('throws NotFoundException when the roles array is empty', async () => {
      const { factory } = factoryReturning([]);

      await expect(factory.createForUser(user, spaceId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the repo returns no roles (null)', async () => {
      const { factory } = factoryReturning(null as any);

      await expect(factory.createForUser(user, spaceId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
