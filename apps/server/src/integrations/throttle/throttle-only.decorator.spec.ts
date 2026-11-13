import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ThrottlerGuard } from '@nestjs/throttler';
import { THROTTLERS } from './throttler-names';

// Metadata keys of @nestjs/throttler (its constants are not exported).
const SKIP = 'THROTTLER:SKIP';
const LIMIT = 'THROTTLER:LIMIT';
const GUARDS = '__guards__';
const PATH = 'path';

const SRC = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return entry.endsWith('.controller.ts') ? [full] : [];
  });
}

// Every route handler guarded by a throttler guard, in every controller file
// that mentions ThrottlerGuard (UserThrottlerGuard extends it).
function throttledRoutes(): { route: string; cls: any; handler: any }[] {
  const routes = [];
  for (const file of controllerFiles(SRC)) {
    if (!readFileSync(file, 'utf8').includes('ThrottlerGuard')) continue;
    // Controller files are discovered at run time, so they are loaded with require.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    for (const cls of Object.values(require(file)) as any[]) {
      if (typeof cls !== 'function' || !cls.prototype) continue;
      for (const key of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[key];
        if (key === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH, handler) === undefined) continue;
        const guards = [
          ...(Reflect.getMetadata(GUARDS, cls) ?? []),
          ...(Reflect.getMetadata(GUARDS, handler) ?? []),
        ];
        const throttled = guards.some(
          (g) => g === ThrottlerGuard || g?.prototype instanceof ThrottlerGuard,
        );
        if (throttled) routes.push({ route: `${cls.name}.${key}`, cls, handler });
      }
    }
  }
  return routes;
}

// The buckets ThrottlerGuard actually counts on a route: handler metadata
// overrides class metadata, as in the guard itself.
function activeBuckets(cls: any, handler: any): string[] {
  return THROTTLERS.map((t) => t.name).filter((name) => {
    const skip =
      Reflect.getMetadata(SKIP + name, handler) ??
      Reflect.getMetadata(SKIP + name, cls);
    return !skip;
  });
}

describe('throttled routes', () => {
  const routes = throttledRoutes();

  it('finds the throttled routes', () => {
    expect(routes.map((r) => r.route)).toEqual(
      expect.arrayContaining([
        'AiChatController.transcribe',
        'AiChatController.stream',
        'PageTemplateController.lookup',
        'VitalsController.vitals',
        'AuthController.login',
      ]),
    );
  });

  it('counts each route against at most one throttler', () => {
    const offenders = routes
      .map((r) => ({ route: r.route, active: activeBuckets(r.cls, r.handler) }))
      .filter((r) => r.active.length > 1);
    expect(offenders).toEqual([]);
  });

  it('counts a route with its own limit against exactly that throttler', () => {
    const offenders = routes
      .map((r) => {
        const own = THROTTLERS.map((t) => t.name).filter(
          (name) => Reflect.getMetadata(LIMIT + name, r.handler) !== undefined,
        );
        return { route: r.route, own, active: activeBuckets(r.cls, r.handler) };
      })
      .filter((r) => r.own.length > 0)
      .filter((r) => JSON.stringify(r.active) !== JSON.stringify(r.own));
    expect(offenders).toEqual([]);
  });

  it('limits transcription only by the ai-chat bucket at 60/min', () => {
    const r = routes.find((x) => x.route === 'AiChatController.transcribe');
    expect(activeBuckets(r.cls, r.handler)).toEqual(['ai-chat']);
    expect(Reflect.getMetadata(LIMIT + 'ai-chat', r.handler)).toBe(60);
  });
});
