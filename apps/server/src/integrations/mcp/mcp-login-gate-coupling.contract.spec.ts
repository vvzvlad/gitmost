import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Coupling / drift-guard contract for the pre-token SSO/MFA gate (Gitea #91).
 *
 * There are TWO independent code paths that must run the SAME pre-token gate
 * before any token is minted from a password:
 *
 *   1) AuthController.login (core/auth/auth.controller.ts) — the normal
 *      /api/auth/login path. Before issuing a token it runs:
 *        validateSsoEnforcement(workspace)
 *        -> lazy require('./../../ee/mfa/services/mfa.service')
 *        -> mfaService.checkMfaRequirements(...)
 *
 *   2) McpService.enforceBasicLoginGate (integrations/mcp/mcp.service.ts) —
 *      the /mcp HTTP-Basic path. It re-implements EXACTLY the same pre-token
 *      sequence so the Basic path is not an SSO/MFA bypass.
 *
 * These two implementations are physically separate (no shared helper — Option 1
 * would extract one, but that refactor is deliberately skipped in this batch).
 * If a future edit drops the SSO check or the MFA check from one side, the two
 * paths silently DRIFT and the dropped side re-opens an SSO/MFA bypass. This
 * test asserts BOTH method bodies still contain BOTH gate calls, so such a drift
 * fails the build.
 *
 * Why a SOURCE-LEVEL (AST) contract test rather than live instances: neither
 * AuthController nor McpService can be constructed — or even imported — under
 * this jest config without mocking their heavy transitive graph (the
 * @docmost/transactional React-email templates and the lib0/ESM collaboration
 * chain that ts-jest's transformIgnorePatterns cannot load). This mirrors the
 * existing AST-contract approach in
 * core/auth/services/verify-user-credentials.contract.spec.ts: read the real
 * source, extract the relevant method bodies, and assert each contains the
 * required calls.
 */

// The exact symbols BOTH pre-token paths must share. Drop any of these from one
// side and that side stops enforcing SSO/MFA before minting a token.
const SSO_GATE = 'validateSsoEnforcement';
// The lazy EE-MFA require specifier — byte-for-byte identical in both files (a
// fork WITHOUT the EE module bundled behaves the same on both sides: no module,
// no MFA gate).
const MFA_REQUIRE = "require('./../../ee/mfa/services/mfa.service')";
// The MFA requirement check both paths call on the lazily-loaded service.
const MFA_CHECK = 'checkMfaRequirements';

/**
 * Strip all comments from a chunk of TS source, leaving only real CODE tokens.
 *
 * This is load-bearing: the method bodies we inspect DOCUMENT the gate they run
 * (e.g. "// 1) validateSsoEnforcement(workspace) — reject if ..."), so a naive
 * substring match on the raw body text would still pass even if the actual call
 * were deleted and only the comment survived. We tokenize with the TS scanner
 * and re-emit only non-comment token text, so the assertions below see code, not
 * prose. (A deleted/commented-out gate call therefore correctly fails the test.)
 */
function stripComments(text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text,
  );
  let out = '';
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
      kind !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      out += scanner.getTokenText();
    } else {
      // Preserve a separator so adjacent tokens around a comment don't merge.
      out += ' ';
    }
    kind = scanner.scan();
  }
  return out;
}

/**
 * Return the COMMENT-STRIPPED source text of a named method body (a class
 * MethodDeclaration). Throws if the method is not found so a rename can never
 * silently make this test vacuous.
 */
function methodBodyText(
  source: string,
  fileLabel: string,
  methodName: string,
): string {
  const sf = ts.createSourceFile(
    fileLabel,
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
    throw new Error(`method ${methodName} not found in ${fileLabel}`);
  }
  return stripComments(found);
}

describe('pre-token SSO/MFA gate coupling contract (Gitea #91)', () => {
  const controllerPath = path.join(
    __dirname,
    '..',
    '..',
    'core',
    'auth',
    'auth.controller.ts',
  );
  const mcpServicePath = path.join(__dirname, 'mcp.service.ts');

  const controllerSource = fs.readFileSync(controllerPath, 'utf8');
  const mcpServiceSource = fs.readFileSync(mcpServicePath, 'utf8');

  // The real login pre-token gate lives inline in AuthController.login.
  const loginBody = methodBodyText(
    controllerSource,
    'auth.controller.ts',
    'login',
  );
  // The /mcp Basic-path mirror lives in McpService.enforceBasicLoginGate.
  const gateBody = methodBodyText(
    mcpServiceSource,
    'mcp.service.ts',
    'enforceBasicLoginGate',
  );

  it('AuthController.login runs the full pre-token gate (SSO + MFA)', () => {
    expect(loginBody).toContain(SSO_GATE);
    expect(loginBody).toContain(MFA_REQUIRE);
    expect(loginBody).toContain(MFA_CHECK);
  });

  it('McpService.enforceBasicLoginGate runs the full pre-token gate (SSO + MFA)', () => {
    expect(gateBody).toContain(SSO_GATE);
    expect(gateBody).toContain(MFA_REQUIRE);
    expect(gateBody).toContain(MFA_CHECK);
  });

  it('both paths share EVERY gate symbol (no drift between the two)', () => {
    // The drift guard: if a future edit drops a gate call from exactly one
    // side, that side fails here while the other still passes — pinpointing the
    // bypass. Both sides carrying the same set keeps them semantically coupled.
    for (const symbol of [SSO_GATE, MFA_REQUIRE, MFA_CHECK]) {
      const inLogin = loginBody.includes(symbol);
      const inGate = gateBody.includes(symbol);
      expect({ symbol, inLogin, inGate }).toEqual({
        symbol,
        inLogin: true,
        inGate: true,
      });
    }
  });

  it('the EE-MFA require specifier is byte-for-byte identical on both sides', () => {
    // A drift in the require PATH (not just its presence) would load a different
    // module on one side — e.g. the controller gating on MFA while the Basic
    // path silently requires a non-existent path and skips MFA. Pin the literal.
    expect(loginBody).toContain(MFA_REQUIRE);
    expect(gateBody).toContain(MFA_REQUIRE);
  });
});
