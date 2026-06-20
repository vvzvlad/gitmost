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
});
