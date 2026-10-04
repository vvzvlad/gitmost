#!/usr/bin/env node
/*
 * git-sync BROWSER e2e — drives the real Docmost web UI with Playwright to
 * reproduce the exact user flow that previously caused data loss: pages created
 * in the browser start UNTITLED (all collapse to the `_` vault filename); typing
 * a title reshuffles that collision and used to TRASH another live page. This
 * test creates several pages via the UI, titles one, runs a sync, and asserts
 * NOTHING was moved to Trash.
 *
 * Setup: needs Playwright + a Chromium build. The project should add
 * `@playwright/test` as a devDep (`pnpm dlx playwright install chromium`). This
 * script resolves playwright-core + the chromium binary from env so it can run
 * against an already-installed browser:
 *   PW_CORE=/path/to/node_modules/playwright-core
 *   PW_CHROME=/path/to/chrome
 * and the live stand env (SERVER/SPACE_ID/EMAIL/PASSWORD/DB_CONTAINER) like the
 * shell e2e suites.
 */
const { execSync } = require('node:child_process');

const SERVER = process.env.SERVER || 'http://localhost:3000';
const WEB = process.env.WEB || 'http://localhost:5173';
const SPACE_ID = process.env.SPACE_ID || '019ef1f7-437b-7ae9-9306-809a1729f085';
const SPACE_SLUG = process.env.SPACE_SLUG || 'general';
const EMAIL = process.env.EMAIL || 'admin@test.local';
const PASSWORD = process.env.PASSWORD || 'Test12345!';
const DB = process.env.DB_CONTAINER || 'gitmost-db';
const PW_CORE = process.env.PW_CORE || '/home/claude/pw/node_modules/playwright-core';
const PW_CHROME = process.env.PW_CHROME ||
  '/home/claude/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';

const { chromium } = require(PW_CORE);
const psql = (q) =>
  execSync(`docker exec ${DB} psql -U docmost -d docmost -tAc "${q}"`, { encoding: 'utf8' }).trim();
const trashedCount = () =>
  Number(psql(`select count(*) from pages where space_id='${SPACE_ID}' and deleted_at is not null`));
let cookie = '';
const login = () => {
  const out = execSync(
    `curl -s -i -X POST ${SERVER}/api/auth/login -H 'Content-Type: application/json' -d '{"email":"${EMAIL}","password":"${PASSWORD}"}'`,
    { encoding: 'utf8' });
  cookie = (out.match(/authToken=([^;]+)/) || [])[1] || '';
};
const sync = () => execSync(
  `curl -s -b 'authToken=${cookie}' -X POST ${SERVER}/api/git-sync/trigger -H 'Content-Type: application/json' -d '{"spaceId":"${SPACE_ID}"}'`,
  { encoding: 'utf8' });

let pass = 0, fail = 0;
const ok = (m) => { console.log('  \x1b[32mPASS\x1b[0m ' + m); pass++; };
const bad = (m) => { console.log('  \x1b[31mFAIL\x1b[0m ' + m); fail++; };

(async () => {
  login();
  const trashBefore = trashedCount();
  const browser = await chromium.launch({ executablePath: PW_CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    // --- log in through the UI ---
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('email@example.com').fill(EMAIL);
    await page.getByPlaceholder(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in|log in|login|войти/i }).click();
    await page.waitForTimeout(2000);
    ok('logged in via the browser');

    // --- create several UNTITLED pages via the UI (the bug trigger) ---
    await page.goto(`${WEB}/s/${SPACE_SLUG}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const createdUrls = [];
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Create page' }).first().click();
      await page.waitForTimeout(1500);
      createdUrls.push(page.url());
      sync(); // each create fires a real git-sync cycle
    }
    ok('created 3 untitled pages through the UI');

    // --- type a title into the page currently open (retitle == the trigger) ---
    const titleEditor = page.locator('.tiptap.ProseMirror').first();
    await titleEditor.click();
    await page.keyboard.type('Заголовок через браузер');
    await page.waitForTimeout(1500); // debounced save
    sync(); sync();
    ok('typed a title into one page');

    // --- THE assertion: nothing got trashed by the reshuffle ---
    const trashAfter = trashedCount();
    if (trashAfter === trashBefore) ok(`no page trashed by the untitled+retitle flow (trash stayed ${trashBefore})`);
    else bad(`a page was TRASHED by the browser flow (trash ${trashBefore} -> ${trashAfter}) — DATA LOSS`);

    // the titled page must still be live
    const titled = Number(psql(`select count(*) from pages where space_id='${SPACE_ID}' and title='Заголовок через браузер' and deleted_at is null`));
    if (titled === 1) ok('the titled page is live'); else bad('the titled page is not live');
  } finally {
    await browser.close();
    // cleanup: hard-delete the pages this run created (titled + the untitled ones from this run)
    psql(`delete from pages where space_id='${SPACE_ID}' and (title='Заголовок через браузер' or (title='' and created_at > now() - interval '5 minutes'))`);
    sync();
  }
  console.log(`\nRESULTS: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
