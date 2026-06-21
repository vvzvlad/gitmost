import { SpaceController } from './space.controller';

// Direct instantiation with stub deps, mirroring the rest of these unit specs.
describe('SpaceController', () => {
  let controller: SpaceController;

  beforeEach(() => {
    controller = new SpaceController(
      {} as any, // spaceService
      {} as any, // spaceMemberService
      {} as any, // spaceMemberRepo
      {} as any, // spaceAbility
      {} as any, // workspaceAbility
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
