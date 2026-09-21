import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Coupling / drift-guard contract for the pre-token SSO/MFA gate (Gitea #91).
 *
 * `AuthController.login` (core/auth/auth.controller.ts) — the normal
 * /api/auth/login password path — must run the SSO/MFA gate BEFORE any token is
 * minted from a password:
 *
 *   validateSsoEnforcement(workspace)
 *   -> lazy require('./../../ee/mfa/services/mfa.service')
 *   -> mfaService.checkMfaRequirements(...)
 *
 * Historically a SECOND path re-implemented the same pre-token sequence: the
 * /mcp HTTP-Basic password path in the MCP service. That twin was REMOVED in
 * #558 (/mcp now accepts only a Bearer api_key — no password path, no gate to
 * mirror), so this guard now covers the ONE remaining password-login path. If a
 * future edit drops the SSO check or the MFA check from `login`, that re-opens an
 * SSO/MFA bypass; this test asserts the method body still contains BOTH gate
 * calls so such a regression fails the build.
 *
 * Why a SOURCE-LEVEL (AST) contract test rather than a live instance:
 * AuthController cannot be constructed — or even imported — under this jest
 * config without mocking its heavy transitive graph (the @docmost/transactional
 * React-email templates and the lib0/ESM collaboration chain that ts-jest's
 * transformIgnorePatterns cannot load). This mirrors the existing AST-contract
 * approach in core/auth/services/verify-user-credentials.contract.spec.ts: read
 * the real source, extract the relevant method body, and assert it contains the
 * required calls.
 */

// The symbols the password-login pre-token path must contain. Drop any of these
// from login() and it stops enforcing SSO/MFA before minting a token.
const SSO_GATE = 'validateSsoEnforcement';
// The lazy EE-MFA require specifier — pinned byte-for-byte (a fork WITHOUT the
// EE module bundled behaves the same: no module, no MFA gate).
const MFA_REQUIRE = "require('./../../ee/mfa/services/mfa.service')";
// The MFA requirement check the path calls on the lazily-loaded service.
const MFA_CHECK = 'checkMfaRequirements';

/**
 * Strip all comments from a chunk of TS source, leaving only real CODE tokens.
 *
 * This is load-bearing: the login body DOCUMENTS the gate it runs (e.g. a
 * comment naming validateSsoEnforcement/checkMfaRequirements), so a naive
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

describe('login SSO/MFA gate coupling contract (Gitea #91)', () => {
  const controllerPath = path.join(__dirname, 'auth.controller.ts');
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');

  // The real login pre-token gate lives inline in AuthController.login.
  const loginBody = methodBodyText(
    controllerSource,
    'auth.controller.ts',
    'login',
  );

  it('AuthController.login runs the full pre-token gate (SSO + MFA)', () => {
    expect(loginBody).toContain(SSO_GATE);
    expect(loginBody).toContain(MFA_REQUIRE);
    expect(loginBody).toContain(MFA_CHECK);
  });

  it('the EE-MFA require specifier is the exact pinned literal', () => {
    // A drift in the require PATH (not just its presence) would load a different
    // module — e.g. silently requiring a non-existent path and skipping MFA.
    // Pin the literal so the specifier cannot be quietly changed.
    expect(loginBody).toContain(MFA_REQUIRE);
  });

  it('is non-vacuous: it inspects a real, comment-stripped method body', () => {
    // If the method were renamed/removed, methodBodyText throws (asserted by the
    // fact loginBody was computed above without error). The body must carry real
    // code — not just the doc-comment prose that names these symbols.
    expect(loginBody.length).toBeGreaterThan(0);
    expect(loginBody).toContain('workspace');
  });
});
