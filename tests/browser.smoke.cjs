// Run against a disposable profile; no desktop input or personal browser profile is used.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = process.env.DEFAULT_ACCOUNT_EXTENSION_DIR || path.resolve(__dirname, '..');
const browserPath = process.env.BROWSER_EXECUTABLE;
if (!browserPath) throw new Error('Set BROWSER_EXECUTABLE to a Chromium/Brave executable that supports --load-extension.');

const accounts = [0, 1, 2].map(index => ({ index, name: `Test ${index}`, email: `test${index}@example.test`, profileUrl: '', isLoggedIn: true }));
const accountResponse = ['gaia.l.a.r', accounts.map(account => {
  const row = Array(16).fill(null);
  row[2] = account.name; row[3] = account.email; row[4] = account.profileUrl;
  row[7] = String(account.index); row[9] = 1; row[14] = 0;
  return row;
})];

async function eventually(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser state');
}

(async () => {
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'default-account-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: browserPath,
      headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--password-store=basic'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    let fetchUsedSession = false;
    let failAccounts = false;
    const requests = [];
    await context.addCookies([{ name: 'fixture_session', value: 'test', domain: '.google.com', path: '/', secure: true, sameSite: 'None' }]);
    await context.route(/^https?:\/\//, async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'accounts.google.com' && url.pathname === '/ListAccounts') {
        fetchUsedSession = (await request.allHeaders()).cookie?.includes('fixture_session=test') || false;
        if (failAccounts) return route.fulfill({ status: 503, body: 'Temporary error' });
        const response = fetchUsedSession ? accountResponse : ['gaia.l.a.r', []];
        const escaped = JSON.stringify(response).replace(/'/g, '\\x27');
        return route.fulfill({ contentType: 'text/html', body: `<html><body><script type="text/javascript">window.parent.postMessage('${escaped}', 'https://accounts.google.com');</script></body></html>` });
      }
      requests.push(request.url());
      return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Google service fixture</h1></body></html>' });
    });
    await worker.evaluate(async accounts => {
      await chrome.storage.sync.set({ accounts, defaultAccount: 0, rules: [] });
    }, accounts);
    const service = await context.newPage();
    await service.goto('https://mail.google.com/mail/u/0/#inbox');
    const popup = await context.newPage();
    const errors = [];
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await eventually(() => fetchUsedSession);
    await eventually(async () => (await popup.locator('#accounts_button').innerText()).includes('(3)'));
    assert.equal(fetchUsedSession, true, 'ListAccounts must send the existing Google session');
    console.log('PASS: account fetch uses the session and renders all accounts');

    await popup.locator('#rules_button').click();
    await popup.locator('#service-picker').selectOption({ label: 'Mail' });
    const accountOption = await popup.locator('#account-picker option').filter({ hasText: 'test2@example.test' }).getAttribute('value');
    assert(accountOption, 'The selected account must remain available');
    await popup.locator('#account-picker').selectOption(accountOption);
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const service = tabs.find(tab => tab.url?.startsWith('https://mail.google.com/'));
      await chrome.tabs.update(service.id, { active: true });
    });
    await popup.getByRole('button', { name: 'Add new rule' }).click();
    await eventually(() => service.url() === 'https://mail.google.com/mail/u/2/#inbox');
    assert.equal(service.url(), 'https://mail.google.com/mail/u/2/#inbox');
    const applied = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    assert(applied.some(rule => rule.action.redirect?.transform?.queryTransform.addOrReplaceParams[0].value === '2'));
    console.log('PASS: saving the service rule installs DNR and switches the current Gmail account');

    // Chromium, rather than a JavaScript regex approximation, applies these rules.
    const fresh = await context.newPage();
    await fresh.goto('https://mail.google.com/mail/');
    assert.equal(new URL(fresh.url()).searchParams.get('authuser'), '2');
    await fresh.goto('https://mail.google.com/mail/?authuser=1');
    assert.equal(new URL(fresh.url()).searchParams.get('authuser'), '2');
    await fresh.goto('https://mail.google.com/mail/u/1/#inbox');
    assert.equal(new URL(fresh.url()).pathname, '/mail/u/1/');
    console.log('PASS: service rules override authuser links and preserve path-based switching without loops');

    // Regression: a Meet override must replace authuser=1 even when the global default is 1.
    await worker.evaluate(async () => {
      const { rules } = await chrome.storage.sync.get('rules');
      await chrome.storage.sync.set({ defaultAccount: 1, rules: [...rules, { serviceName: 'Meet', serviceUrl: 'meet.google.com', accountId: 2 }] });
    });
    await eventually(async () => {
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      return rules.some(rule => rule.condition.regexFilter.includes('meet') && rule.action.redirect?.transform?.queryTransform.addOrReplaceParams[0].value === '2');
    });
    await fresh.goto('https://meet.google.com/home?authuser=1');
    assert.equal(fresh.url(), 'https://meet.google.com/home?authuser=2');
    await fresh.goto('https://meet.google.com/home?authuser=2');
    assert.equal(fresh.url(), 'https://meet.google.com/home?authuser=2');
    await fresh.goto('https://analytics.google.com/?authuser=2');
    assert.equal(new URL(fresh.url()).searchParams.get('authuser'), '1');
    console.log('PASS: Meet authuser=1 becomes authuser=2 using its override; correct URLs do not loop; other services use the global default');

    failAccounts = true;
    await popup.reload();
    await eventually(async () => (await popup.locator('#accounts_status').innerText()).includes('Could not load'));
    assert.equal(await popup.locator('#accounts_body .cell-body').count(), 3);
    await popup.locator('#rules_button').click();
    assert.equal(await popup.locator('#account-picker option').count(), 3);
    assert.deepEqual(errors, []);
    console.log('PASS: a Google HTTP failure preserves cached accounts and rule controls without popup errors');

    await worker.evaluate(async () => {
      await chrome.storage.sync.set({ defaultAccount: 1, rules: [] });
      await chrome.storage.sync.set({ defaultAccount: 2 });
    });
    await eventually(async () => {
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      return rules.filter(rule => rule.action.type === 'redirect').every(rule =>
        rule.action.redirect.url?.includes('authuser=2') || rule.action.redirect.transform?.queryTransform.addOrReplaceParams[0].value === '2');
    });
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    assert(rules.length > 0 && rules.length < 100);
    console.log(`PASS: rapid settings changes finish with the latest account (${rules.length} valid browser rules)`);
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
