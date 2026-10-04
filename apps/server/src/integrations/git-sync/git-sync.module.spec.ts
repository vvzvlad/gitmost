// register() only REFERENCES the imported Nest modules; loading them for real
// runs env validation (process.exit) and drags in the whole app graph, so stub
// them with bare classes.
jest.mock('@docmost/db/database.module', () => ({
  DatabaseModule: class DatabaseModule {},
}));
jest.mock('../environment/environment.module', () => ({
  EnvironmentModule: class EnvironmentModule {},
}));
jest.mock('../../collaboration/collaboration.module', () => ({
  CollaborationModule: class CollaborationModule {},
}));
jest.mock('../../core/page/page.module', () => ({
  PageModule: class PageModule {},
}));
jest.mock('../../core/auth/auth.module', () => ({
  AuthModule: class AuthModule {},
}));

import { GitSyncModule } from './git-sync.module';
import { GitSyncController } from './git-sync.controller';
import { GitSyncOrchestrator } from './services/git-sync.orchestrator';
import { GitHttpService } from './http/git-http.service';

// With GIT_SYNC_ENABLED off the deployment must behave exactly like develop: no
// /api/git-sync routes, no orchestrator poll, no listener, no /git host (and no
// GitHttpService limiter timer). Pin the register() gate here.
describe('GitSyncModule.register (GIT_SYNC_ENABLED gate)', () => {
  const original = process.env.GIT_SYNC_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.GIT_SYNC_ENABLED;
    else process.env.GIT_SYNC_ENABLED = original;
  });

  it('OFF by default (flag unset) — no imports, controllers, providers or exports', () => {
    delete process.env.GIT_SYNC_ENABLED;
    const mod = GitSyncModule.register();
    expect(mod.imports).toEqual([]);
    expect(mod.controllers).toEqual([]);
    expect(mod.providers).toEqual([]);
    expect(mod.exports).toEqual([]);
  });

  it.each(['false', '', '1', 'yes'])(
    'stays OFF for non-"true" value %p',
    (val) => {
      process.env.GIT_SYNC_ENABLED = val;
      const mod = GitSyncModule.register();
      expect(mod.imports).toEqual([]);
      expect(mod.controllers).toEqual([]);
      expect(mod.providers).toEqual([]);
      expect(mod.exports).toEqual([]);
    },
  );

  it('ON for "true" — registers the controller, providers and the /git export', () => {
    process.env.GIT_SYNC_ENABLED = 'true';
    const mod = GitSyncModule.register();
    expect(mod.controllers).toContain(GitSyncController);
    expect(mod.providers).toEqual(
      expect.arrayContaining([GitSyncOrchestrator, GitHttpService]),
    );
    expect(mod.exports).toContain(GitHttpService);
  });
});
