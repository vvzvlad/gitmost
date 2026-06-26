import { injectTrackerHead } from './inject-tracker-head.util';

// Pins the public-share trackerHead injection invariant (ShareSeoController).
// The admin snippet is trusted content and MUST land byte-for-byte before the
// first </head>. The critical regression these tests guard is the function vs
// string replacer: a string replacement interprets `$&`/`$$`/`` $` ``/`$'`
// inside the snippet as substitution patterns and mangles the tracker. The
// byte-for-byte test below FAILS on the old string-replacer implementation and
// passes only with the function replacer.

const HTML = '<html><head><title>t</title></head><body>b</body></html>';

describe('injectTrackerHead', () => {
  it('inserts the snippet immediately before the first </head>', () => {
    const out = injectTrackerHead(HTML, '<script>ga()</script>');
    expect(out).toBe(
      '<html><head><title>t</title><script>ga()</script>\n</head><body>b</body></html>',
    );
  });

  it('inserts a snippet containing $& byte-for-byte (function replacer)', () => {
    const snippet = '<script>var a="$&";</script>';
    const out = injectTrackerHead(HTML, snippet);
    expect(out).toContain(`${snippet}\n</head>`);
    // The literal "$&" survives; a string replacer would have spliced in the
    // matched "</head>" here.
    expect(out).toContain('$&');
    expect(out).not.toContain('</head>"');
  });

  it('inserts a snippet containing $$, $` and $\' byte-for-byte', () => {
    // All four special replacement patterns in one snippet.
    const snippet = "<!-- $$ $` $' $& -->";
    const out = injectTrackerHead(HTML, snippet);
    expect(out).toContain(`${snippet}\n</head>`);
  });

  it('returns html unchanged for an empty trackerHead', () => {
    expect(injectTrackerHead(HTML, '')).toBe(HTML);
  });

  it('returns html unchanged for a whitespace-only trackerHead', () => {
    expect(injectTrackerHead(HTML, '   \n\t ')).toBe(HTML);
  });

  it('returns html unchanged for an undefined trackerHead', () => {
    expect(injectTrackerHead(HTML, undefined)).toBe(HTML);
  });

  it('returns html unchanged when there is no </head> marker', () => {
    const noHead = '<html><body>no head here</body></html>';
    expect(injectTrackerHead(noHead, '<script>ga()</script>')).toBe(noHead);
  });

  it('injects before only the FIRST </head> when several exist', () => {
    const twoHeads = '<head></head><head></head>';
    const out = injectTrackerHead(twoHeads, 'X');
    expect(out).toBe('<head>X\n</head><head></head>');
  });
});
