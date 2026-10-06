import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildRedirectRules, getAccountByIndex } from '../redirect-rules.js';

const utils = readFileSync(new URL('../utils.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '');
const signedInAccounts = [0, 1, 2].map(index => ({ index, isLoggedIn: true }));

function setupWorker() {
  let settings = { defaultAccount: 0, rules: [], accounts: signedInAccounts };
  let installed = [];
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const chrome = {
    storage: {
      sync: {
        get: (keys, callback) => callback(structuredClone(settings)),
        set: (data, callback) => { Object.assign(settings, data); callback?.(); },
      },
      onChanged: event('storage'),
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => installed),
      updateDynamicRules: vi.fn(async ({ addRules }) => { installed = addRules; }),
    },
    runtime: { onInstalled: event('installed'), onMessage: event('message') },
    tabs: {
      onCreated: event('tabCreated'),
      query: vi.fn(async () => [{ id: 7, url: 'https://mail.google.com/mail/u/0/#inbox' }]),
      update: vi.fn(async () => {}),
    },
    commands: { onCommand: event('command') },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, buildRedirectRules, getAccountByIndex });
  vm.runInContext(workerSource, context);
  return { context, chrome, listeners, settings, installed: () => installed };
}

describe('Switching an existing Google account', () => {
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(utils, context);
  const convert = context.convertToRedirectUrl;

  it.each([
    ['https://mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/2/#inbox'],
    ['https://calendar.google.com/calendar/u/0/r', 'https://calendar.google.com/calendar/u/2/r'],
    ['https://drive.google.com/drive/u/0/folders/test?foo=1', 'https://drive.google.com/drive/u/2/folders/test?foo=1'],
    ['https://gemini.google.com/u/0/app', 'https://gemini.google.com/u/2/app'],
    ['https://mail.google.com/mail/u/0/?authuser=2#inbox', 'https://mail.google.com/mail/u/2/?authuser=2#inbox'],
    ['https://meet.google.com/home?authuser=0', 'https://meet.google.com/home?authuser=2'],
  ])('switches %s to the requested account', (url, expected) => {
    expect(convert(url, 2)).toBe(expected);
  });

  it('ignores account-like paths inside query strings', () => {
    expect(convert('https://docs.google.com/document/d/test?continue=/u/2/', 2))
      .toBe('https://docs.google.com/document/d/test?continue=%2Fu%2F2%2F&authuser=2');
  });

  it('does not reload an already selected account', () => {
    expect(convert('https://mail.google.com/mail/u/2/#inbox', 2)).toBeNull();
  });
});

describe('Google account numbers', () => {
  const accounts = [
    { index: -1, isLoggedIn: false },
    { index: 0, isLoggedIn: true },
    { index: 2, isLoggedIn: true },
  ];
  it('finds accounts by their Google number, not their array position', () => {
    expect(getAccountByIndex(accounts, 1)).toBeUndefined();
    expect(getAccountByIndex(accounts, 0)).toBe(accounts[1]);
    expect(getAccountByIndex(accounts, 2)).toBe(accounts[2]);
  });
  it('does not silently disable a service rule after a signed-out entry is inserted', () => {
    const rules = buildRedirectRules({ defaultAccount: 0, accounts, customRules: [{ serviceName: 'Mail', accountId: 2 }] });
    expect(rules.some(rule => rule.action.redirect?.transform?.queryTransform.addOrReplaceParams[0].value === '2')).toBe(true);
    expect(buildRedirectRules({ defaultAccount: 1, accounts })).toEqual([]);
  });
});

describe('Applying rules from the popup', () => {
  it('installs changes arriving during another rule update', async () => {
    const worker = setupWorker();
    await worker.context.updateRedirectRules();
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    let began;
    const started = new Promise(resolve => { began = resolve; });
    worker.chrome.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(async () => { began(); await paused; });
    worker.settings.defaultAccount = 1;
    const first = worker.context.updateRedirectRules();
    await started;
    worker.settings.defaultAccount = 2;
    const second = worker.context.updateRedirectRules();
    release();
    await Promise.all([first, second]);
    const redirect = worker.installed().find(rule => rule.action.redirect?.transform);
    expect(redirect.action.redirect.transform.queryTransform.addOrReplaceParams[0].value).toBe('2');
  });

  it('applies the service rule before switching the matching active tab', async () => {
    const worker = setupWorker();
    worker.settings.rules = [{ serviceName: 'Mail', accountId: 2 }];
    const response = await new Promise(resolve => {
      expect(worker.listeners.message({ type: 'apply_redirect_rules', accountId: 2, serviceUrl: 'mail.google.com' }, {}, resolve)).toBe(true);
    });
    expect(response).toEqual({ success: true });
    expect(worker.chrome.tabs.update).toHaveBeenCalledWith(7, { url: 'https://mail.google.com/mail/u/2/#inbox' });
    expect(worker.chrome.declarativeNetRequest.updateDynamicRules.mock.invocationCallOrder[0])
      .toBeLessThan(worker.chrome.tabs.update.mock.invocationCallOrder[0]);
  });

  it('does not switch an unrelated active service', async () => {
    const worker = setupWorker();
    await new Promise(resolve => worker.listeners.message({ type: 'apply_redirect_rules', accountId: 2, serviceUrl: 'drive.google.com' }, {}, resolve));
    expect(worker.chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('reports Chrome rule-installation errors without navigating', async () => {
    const worker = setupWorker();
    await worker.context.updateRedirectRules();
    worker.chrome.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(new Error('DNR rejected rules'));
    const response = await new Promise(resolve => worker.listeners.message({ type: 'apply_redirect_rules', accountId: 2 }, {}, resolve));
    expect(response.error).toBe('DNR rejected rules');
    expect(worker.chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('Google login status', () => {
  const source = readFileSync(new URL('../accounts.js', import.meta.url), 'utf8');
  function parse(row) {
    const storage = { store: vi.fn(), get: () => {} };
    const context = vm.createContext({
      window: {}, SyncStorage: storage,
      document: { getElementById: () => ({ textContent: '' }) },
    });
    vm.runInContext(source, context);
    context.renderNumberOfAccounts = () => {};
    context.renderAccounts = () => {};
    context.populate(['gaia.l.a.r', [row]]);
    return storage.store.mock.calls[0]?.[0].accounts[0];
  }
  it('uses session flags instead of assuming an account needs 16 fields', () => {
    const row = Array(15).fill(null);
    row[7] = '2'; row[9] = 1; row[14] = 0;
    expect(parse(row)).toMatchObject({ index: 2, isLoggedIn: true });
  });
  it.each([[0, 0], [1, 1]])('does not redirect an expired or signed-out 16-field account', (valid, signedOut) => {
    const row = Array(16).fill(null);
    row[7] = 2; row[9] = valid; row[14] = signedOut;
    expect(parse(row).isLoggedIn).toBe(false);
  });
  it('does not replace cached accounts after an invalid response', () => {
    const storage = { store: vi.fn(), get: () => {} };
    const status = { textContent: '' };
    const context = vm.createContext({ window: {}, SyncStorage: storage, document: { getElementById: () => status } });
    vm.runInContext(source, context);
    context.populate(undefined);
    expect(storage.store).not.toHaveBeenCalled();
    expect(status.textContent).toContain('Could not load');
  });
});

describe('Firefox compatibility', () => {
  function setupFirefox() {
    const settings = { defaultAccount: 0, rules: [], accounts: signedInAccounts };
    const listeners = {};
    const event = name => ({ addListener: listener => { listeners[name] = listener; } });
    const chrome = {
      storage: { sync: { get: (keys, callback) => callback(settings), set: (obj, callback) => callback?.() }, onChanged: event('storage') },
      runtime: { onInstalled: event('installed'), onMessage: event('message'), sendMessage: vi.fn() },
      webRequest: { onBeforeRequest: event('request') },
      tabs: { onCreated: event('created'), query: (options, callback) => callback([{id: 7, url: 'https://mail.google.com/mail/u/0/#inbox'}]), update: vi.fn((id, options, callback) => callback?.()) },
      commands: { onCommand: event('command') },
    };
    const context = vm.createContext({ chrome, URL, URLSearchParams, console });
    vm.runInContext(utils, context);
    vm.runInContext(readFileSync(new URL('../background-firefox.js', import.meta.url), 'utf8'), context);
    return { settings, chrome, listeners };
  }
  it('handles the shared popup message and switches a service path', () => {
    const worker = setupFirefox();
    const reply = vi.fn();
    expect(worker.listeners.message({ type: 'apply_redirect_rules', accountId: 2, serviceUrl: 'mail.google.com' }, {}, reply)).toBe(true);
    expect(reply).toHaveBeenCalledWith({ success: true });
    expect(worker.chrome.tabs.update.mock.calls[0].slice(0, 2)).toEqual([7, { url: 'https://mail.google.com/mail/u/2/#inbox' }]);
  });
  it('switches through keyboard shortcuts without messaging the background itself', () => {
    const worker = setupFirefox();
    worker.listeners.command('switch_to_ga_3');
    expect(worker.chrome.tabs.update).toHaveBeenCalled();
    expect(worker.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
