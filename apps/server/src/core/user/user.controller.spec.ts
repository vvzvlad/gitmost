import { UserController } from './user.controller';

// Direct instantiation with stub deps, mirroring the rest of these unit specs.
describe('UserController', () => {
  let controller: UserController;

  beforeEach(() => {
    controller = new UserController(
      {} as any, // userService
      {} as any, // workspaceRepo
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
