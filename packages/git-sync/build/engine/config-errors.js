import { ZodError } from 'zod';
// Turn a ZodError from settings validation into a clear, actionable startup
// message that names the offending env var(s), then exit(1) — no raw stack
// trace. Mirrors the Python new-project skeleton's load_settings_or_exit.
// A non-ZodError is left to propagate unchanged.
export function loadSettingsOrExit(factory) {
    try {
        return factory();
    }
    catch (err) {
        if (!(err instanceof ZodError))
            throw err;
        const missing = [];
        const invalid = [];
        for (const issue of err.issues) {
            const name = issue.path.length ? String(issue.path[0]) : '?';
            // A missing required variable surfaces as an `invalid_type` issue whose
            // received value was `undefined`. zod 3 exposed `issue.received` directly;
            // zod 4 dropped that field and instead folds it into the message
            // ("expected string, received undefined"). Detect both shapes so the
            // missing-vs-invalid split holds across zod majors. NOTE: an invalid (but
            // present) value uses a different code (invalid_format / invalid_value) or
            // an `invalid_type` message that reports a non-undefined received (e.g.
            // "received NaN" from a coerced number), so neither is misread as missing.
            const i = issue;
            const isMissing = issue.code === 'invalid_type' &&
                (i.received === 'undefined' ||
                    /received undefined/i.test(i.message ?? ''));
            if (isMissing)
                missing.push(name);
            else
                invalid.push(`${name}: ${issue.message}`);
        }
        const lines = ['Configuration error in environment / .env:'];
        if (missing.length) {
            lines.push('  Missing required variable(s):');
            for (const n of [...new Set(missing)])
                lines.push(`    - ${n}`);
        }
        if (invalid.length) {
            lines.push('  Invalid value(s):');
            for (const item of invalid)
                lines.push(`    - ${item}`);
        }
        lines.push('');
        lines.push('Set them in .env (see .env.example) and try again.');
        process.stderr.write(lines.join('\n') + '\n');
        process.exit(1);
    }
}
