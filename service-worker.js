// Service Worker for Default Account+ for Google (Manifest V3)

import { buildRedirectRules, getAccountByIndex } from './redirect-rules.js';

// ============================================================
// Storage Helper Class
// ============================================================
class SyncStorage {
  static store(obj, callback) {
    chrome.storage.sync.set(obj, callback);
  }

  static get(key, callback) {
    chrome.storage.sync.get(key, callback);
  }

  static async getAsync(key) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(key, resolve);
    });
  }

  static async storeAsync(obj) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(obj, resolve);
    });
  }
}

// ============================================================
// Google Service URL Detection
// ============================================================
// Full list of Google Services subdomains - https://gist.github.com/abuvanth/b9fcbaf7c77c2954f96c6e556138ffe8
function isGoogleServiceUrl(url) {
  return (
    /^https?:\/\/[^?&]*(?:mail|drive|calendar|meet|docs|admin|photos|translate|keep|hangouts|chat|workspace|maps|news|ads|ediscovery|jamboard|earth|podcasts|classroom|business|myaccount|adsense|cloud|adwords|analytics|firebase|play|voice|tagmanager|duo|datastudio|optimize|merchants|finance|colab\.research|contacts|script|messages|search|stadia|developers|one|chrome|books|sites|groups|gemini|notebooklm|aistudio)\.google\.co.*/i.test(
      url
    ) ||
    // test several services that switched from the pattern "https://maps.google.com" -> https://www.google.com/maps
    /^https?:\/\/(www\.)?google\.co(?:m|\.[a-z]{2,3})\/(?:maps|finance|travel|flights)/i.test(
      url
    )
  );
}

function isAnyGoogleUrl(url) {
  return /^https?:\/\/([^?&]*\.)?google\.co.*/i.test(url);
}

// ============================================================
// URL Conversion
// ============================================================
// converts the "originalUrl" to the redirectUrl
// if defaultAccount is the same as in "?authuser={num}" or "/u/{num}" - returns null (meaning no need for redirect)
function convertToRedirectUrl(originalUrl, defaultAccount) {
  try {
    const url = new URL(originalUrl);
    const account = String(defaultAccount);
    // Google's /u/N/ route takes precedence over the authuser query parameter.
    // Update both when switching an already open service, preserving its view.
    const pathMatch = url.pathname.match(/\/u\/(\d+)(?=\/|$)/);
    const authuser = url.searchParams.get('authuser');
    if (pathMatch) {
      if (pathMatch[1] === account && (authuser === null || authuser === account)) return null;
      url.pathname = url.pathname.replace(/\/u\/\d+(?=\/|$)/, `/u/${account}`);
      if (authuser !== null) url.searchParams.set('authuser', account);
    } else {
      if (authuser === account) return null;
      url.searchParams.set('authuser', account);
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function redirectCurrentTab(defaultAccount, serviceUrl) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.url || !isGoogleServiceUrl(tab.url)) return;
  if (serviceUrl) {
    const host = new URL(tab.url).hostname;
    if (host !== serviceUrl && !host.endsWith(`.${serviceUrl}`)) return;
  }
  const url = convertToRedirectUrl(tab.url, defaultAccount);
  if (url) await chrome.tabs.update(tab.id, { url });
}


// ============================================================
// Offscreen Document Management for Parsing
// ============================================================
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse Google accounts response which requires DOMParser'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function parseAccountsWithOffscreen(rawText) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'parse_accounts', rawText }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.error) {
        reject(new Error(response?.error || 'No account parser response'));
        return;
      }
      resolve(response.result);
    });
  });
}

// ============================================================
// Declarative Net Request Rules Management
// ============================================================
// We use dynamic rules to redirect Google service URLs to include the correct authuser parameter
// This replaces the webRequest.onBeforeRequest blocking listener from MV2

const RULE_ID_BASE = 1000;
const MAX_RULES = 100;
let rulesUpdatePromise = null;
let rulesUpdateRequested = false;

function updateRedirectRules() {
  rulesUpdateRequested = true;
  if (rulesUpdatePromise) return rulesUpdatePromise;

  rulesUpdatePromise = (async () => {
    // Storage may change while Chrome is installing the previous snapshot.
    // Coalesce requests, then read and apply the latest settings before resolving.
    while (rulesUpdateRequested) {
      rulesUpdateRequested = false;
      const data = await SyncStorage.getAsync(['defaultAccount', 'rules', 'accounts']);
      const newRules = buildRedirectRules({
        defaultAccount: data.defaultAccount ?? 0,
        customRules: data.rules ?? [],
        accounts: data.accounts ?? [],
        ruleIdBase: RULE_ID_BASE
      });
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingRules.map(rule => rule.id),
        addRules: newRules.slice(0, MAX_RULES)
      });
    }
  })().finally(() => { rulesUpdatePromise = null; });
  return rulesUpdatePromise;
}

function scheduleRedirectRulesUpdate() {
  updateRedirectRules().catch(error => console.error('Failed to update redirect rules:', error));
}

// ============================================================
// Installation and Storage Change Handlers
// ============================================================
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    SyncStorage.get('rules', (data) => {
      if (data.rules === undefined) {
        SyncStorage.store({ rules: [] });
      }
    });
    SyncStorage.get('defaultAccount', (data) => {
      if (data.defaultAccount === undefined) {
        SyncStorage.store({ defaultAccount: 0 });
      }
    });
  }

  // Update rules on install/update
  scheduleRedirectRulesUpdate();
});

// Listen for storage changes and update rules accordingly
chrome.storage.onChanged.addListener(function (changes, namespace) {
  if (namespace === 'sync') {
    if ('defaultAccount' in changes || 'rules' in changes || 'accounts' in changes) {
      scheduleRedirectRulesUpdate();
    }
  }
});

// ============================================================
// Message Handling
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'apply_redirect_rules') {
    if (!Number.isInteger(message.accountId) || message.accountId < 0) {
      sendResponse({ error: 'Invalid account number' });
      return;
    }
    updateRedirectRules()
      .then(() => redirectCurrentTab(message.accountId, message.serviceUrl))
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (message === 'fetch_google_accounts') {
    const url =
      'https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&origin=https://accounts.google.com';

    fetch(url, { credentials: 'include', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Google returned HTTP ${response.status}`);
        return response.text();
      })
      .then(async (rawText) => {
        try {
          // Use offscreen document for parsing
          const result = await parseAccountsWithOffscreen(rawText);
          sendResponse(result);
        } catch (error) {
          console.error('Failed to parse accounts:', error);
          // Fallback: try regex-based parsing
          try {
            const match = rawText.match(/<script>.*?'([^']+)'.*?<\/script>/s);
            if (match && match[1]) {
              const decoded = match[1]
                .replace(/\\x([0-9a-fA-F]{2})/g, (m, p) =>
                  String.fromCharCode(parseInt(p, 16))
                )
                .replace(/\\\//g, '/')
                .replace(/\\n/g, '');
              sendResponse(JSON.parse(decoded));
            } else {
              sendResponse({ error: 'Could not load Google accounts. Try again.' });
            }
          } catch {
            sendResponse({ error: 'Could not load Google accounts. Try again.' });
          }
        }
      })
      .catch((error) => {
        console.error('Failed to fetch accounts:', error);
        sendResponse({ error: 'Could not load Google accounts. Try again.' });
      });

    return true; // Keep the message channel open for async response
  }

});

// ============================================================
// Tab Navigation Handler
// ============================================================
// Handle new tabs opened to Google services
chrome.tabs.onCreated.addListener(async (tab) => {
  const url = tab.pendingUrl || tab.url;
  if (!url || !isGoogleServiceUrl(url)) return;

  const data = await SyncStorage.getAsync(['defaultAccount', 'rules', 'accounts']);
  const defaultAccount = data.defaultAccount ?? 0;
  const customRules = data.rules ?? [];
  const accounts = data.accounts ?? [];

  // Check if URL already has authuser
  if (url.toLowerCase().includes('authuser') || /\/u\/\d+/i.test(url)) {
    return;
  }

  // Determine which account to use
  let accountId = defaultAccount;
  for (const rule of customRules) {
    const reg = new RegExp(
      `^https?://[^?&]*${rule.serviceName.toLowerCase()}\\.google\\.co.*`,
      'is'
    );
    if (reg.test(url)) {
      accountId = rule.accountId;
      break;
    }
  }

  // Skip if account 0 or not logged in
  if (accountId === 0 || !getAccountByIndex(accounts, accountId)?.isLoggedIn) {
    return;
  }

  // Check if opened from another Google page
  if (tab.openerTabId) {
    try {
      const openerTab = await chrome.tabs.get(tab.openerTabId);
      if (openerTab && isAnyGoogleUrl(openerTab.url)) {
        return; // Don't redirect if opened from Google
      }
    } catch {
      // Opener tab may not exist
    }
  }

  const redirectUrl = convertToRedirectUrl(url, accountId);
  if (redirectUrl) {
    chrome.tabs.update(tab.id, { url: redirectUrl });
  }
});

// ============================================================
// Keyboard Shortcuts Handler
// ============================================================
chrome.commands.onCommand.addListener((command) => {
  if (command?.indexOf('switch_to_ga_') >= 0) {
    try {
      const accNum = parseInt(command.charAt(command.length - 1)) - 1;
      SyncStorage.get('accounts', (data) => {
        // redirect only if accNum is not > than total number of accounts
        if (getAccountByIndex(data.accounts ?? [], accNum)?.isLoggedIn) {
          redirectCurrentTab(accNum).catch(error => console.error('Failed to switch account:', error));
        }
      });
    } catch {
      // Ignore errors
    }
  }
});

// ============================================================
// Service Worker Startup
// ============================================================
// Initialize rules when service worker starts
scheduleRedirectRulesUpdate();

