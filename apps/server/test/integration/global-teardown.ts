import { destroyTestDb } from './db';

/**
 * Jest globalTeardown: close any pools opened in the setup-process scope so jest
 * exits cleanly. The test workers destroy their own connections in afterAll.
 * We intentionally LEAVE docmost_test in place for post-mortem debuggability;
 * global-setup drops + recreates it on the next run.
 */
export default async function globalTeardown(): Promise<void> {
  await destroyTestDb();
}
