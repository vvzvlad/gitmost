import { GroupController } from './group.controller';

// Direct instantiation with stub deps, mirroring the rest of these unit specs.
describe('GroupController', () => {
  let controller: GroupController;

  beforeEach(() => {
    controller = new GroupController(
      {} as any, // groupService
      {} as any, // groupUserService
      {} as any, // workspaceAbility
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
