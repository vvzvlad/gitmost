import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Security contract for AuthService.verifyUserCredentials (item 4).
 *
 * verifyUserCredentials is the NON-side-effecting credential check used by the
 * /mcp anti-fixation path on subsequent requests: it must perform the same
 * lookup/password/email-verified/disabled checks as login() but mint NO session,
 * write NO USER_LOGIN audit row and update NO lastLoginAt. Calling the
 * side-effecting login() per /mcp tool call would be audit spam + a
 * session-table DoS, so the no-side-effect property is load-bearing.
 *
 * Why this is a SOURCE-LEVEL (AST) contract test rather than a live AuthService
 * unit: AuthService cannot be constructed — or even imported — under this jest
 * config. jest is rooted at `src/` with no `^src/(.*)` moduleNameMapper, so the
 * transitive `import ... from 'src/integrations/queue/constants'` chain
 * (AuthService -> SignupService -> WorkspaceService -> SpaceService) does not
 * resolve; and even with that mapped, importing AuthService pulls in the
 * `@docmost/transactional` React email templates and the lib0/ESM collaboration
 * graph, which jest's ts-jest transform (with the repo's transformIgnorePatterns)
 * cannot load. (The pre-existing auth.service.spec.ts placeholder fails to run
 * for exactly this reason.) So we assert the contract STRUCTURALLY against the
 * real source: verifyUserCredentials must contain none of the three side
 * effects, and login() must contain all three — a regression that adds a side
 * effect to verifyUserCredentials, or drops one from login, fails this test.
 */

const SIDE_EFFECTS = [
  // session/token mint (user_sessions insert + JWT)
  'createSessionAndToken',
  // USER_LOGIN audit event (precise call expression, not a bare "log")
  'auditService.log',
  // lastLoginAt bump
  'updateLastLogin',
] as const;

function methodBodyText(source: string, methodName: string): string {
  const sf = ts.createSourceFile(
    'auth.service.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName &&
      node.body
    ) {
      found = node.body.getText(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (found === null) {
    throw new Error(`method ${methodName} not found in auth.service.ts`);
  }
  return found;
}

describe('AuthService no-side-effect contract (item 4)', () => {
  const sourcePath = path.join(__dirname, 'auth.service.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  const verifyBody = methodBodyText(source, 'verifyUserCredentials');
  const loginBody = methodBodyText(source, 'login');

  it('verifyUserCredentials performs NONE of the side effects', () => {
    // No session/token mint, no audit log write, no lastLoginAt update.
    expect(verifyBody).not.toContain('createSessionAndToken');
    expect(verifyBody).not.toContain('updateLastLogin');
    expect(verifyBody).not.toContain('auditService.log');
    // It still does the real credential work (lookup + password compare).
    expect(verifyBody).toContain('findByEmail');
    expect(verifyBody).toContain('comparePasswordHash');
    // ...and returns the matched user (so login() can reuse it).
    expect(verifyBody).toContain('return user');
  });

  it('login() performs ALL three side effects', () => {
    expect(loginBody).toContain('updateLastLogin');
    expect(loginBody).toContain('auditService.log');
    expect(loginBody).toContain('createSessionAndToken');
    // login() reuses verifyUserCredentials, so there is no behaviour drift
    // between the side-effecting and non-side-effecting credential paths.
    expect(loginBody).toContain('verifyUserCredentials');
  });

  it('every side effect that login() has is ABSENT from verifyUserCredentials', () => {
    for (const effect of SIDE_EFFECTS) {
      expect(loginBody.includes(effect)).toBe(true);
      expect(verifyBody.includes(effect)).toBe(false);
    }
  });

  // Item 4: user-enumeration timing-oracle fix. When the email is missing or the
  // user is disabled, verifyUserCredentials must still run ONE bcrypt comparison
  // (against a dummy hash) BEFORE throwing, so the missing/disabled path takes
  // about the same time as the real-user wrong-password path. Asserted at the
  // source level for the same reason as the rest of this file: AuthService cannot
  // be imported under this jest config to spy on comparePasswordHash live.
  describe('constant-time missing/disabled branch (item 4)', () => {
    // Isolate the body of the
    // `if (!user || isUserDisabled(user) || !user.password) { ... }` guard.
    const guardMatch = verifyBody.match(
      /if \(!user \|\| isUserDisabled\(user\) \|\| !user\.password\) \{([\s\S]*?)\n {4}\}/,
    );

    it('the missing/disabled guard runs a bcrypt compare before throwing', () => {
      expect(guardMatch).not.toBeNull();
      const guardBody = guardMatch![1];
      // It performs the dummy bcrypt comparison...
      expect(guardBody).toContain('comparePasswordHash');
      // ...and only AFTER that throws the credentials error (compare precedes
      // the throw STATEMENT — match `throw new`, not the word "throw" in a comment).
      const compareIdx = guardBody.indexOf('comparePasswordHash');
      const throwIdx = guardBody.indexOf('throw new');
      expect(compareIdx).toBeGreaterThanOrEqual(0);
      expect(throwIdx).toBeGreaterThan(compareIdx);
    });

    // null-password (SSO/LDAP-only) accounts have user.password === null. The
    // missing/disabled guard MUST also short-circuit on a null/empty password,
    // otherwise comparePasswordHash(loginDto.password, null) feeds null to native
    // bcrypt, which REJECTS ("data and hash arguments required") — a 500 on
    // /api/auth/login and a leaky, limiter-evading 401 on /mcp. A regression that
    // drops this null check fails here.
    it('the guard also short-circuits null-password (SSO/LDAP-only) accounts', () => {
      expect(guardMatch).not.toBeNull();
      // The guard CONDITION includes a null/empty password check...
      expect(verifyBody).toMatch(
        /if \(!user \|\| isUserDisabled\(user\) \|\| !user\.password\)/,
      );
      // ...and the password-less branch reuses the same dummy-compare-then-throw
      // body, so it never reaches the real `comparePasswordHash(..., user.password)`.
      const guardBody = guardMatch![1];
      expect(guardBody).toContain('comparePasswordHash');
      expect(guardBody).toContain('throw new');
    });

    it('uses a module-level dummy hash constant (never a real credential)', () => {
      // The dummy hash is a module-level constant referenced in the guard, not an
      // inline literal recomputed per call.
      expect(verifyBody).toContain('DUMMY_PASSWORD_HASH');
      // Cost factor MUST be 12 to match production saltRounds, otherwise the
      // dummy compare is faster than a real wrong-password compare and the
      // timing oracle survives.
      expect(source).toMatch(/const DUMMY_PASSWORD_HASH =\s*'\$2b\$12\$/);
    });
  });
});
