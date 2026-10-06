# Default Account+ for Google

A fork of [badrisnarayanan/default.wtf](https://github.com/badrisnarayanan/default.wtf), based on the original [uptechteam/default.wtf](https://github.com/uptechteam/default.wtf), with account-switching fixes for Manifest V3 browsers.

## What's New in v2.0

- **Manifest V3 Support**: Updated for Chrome's latest extension platform
- **New Google Services**: Added support for Gemini, NotebookLM, AppSheet
- **Firefox Support**: Maintains MV2 compatibility for Firefox
- **Service Worker Architecture**: Replaced persistent background page with service worker
- **Declarative Net Request**: Uses modern Chrome API for URL redirects

## Features

- Set a default Google account for all Google services
- Create per-service rules (e.g., use Account #2 for Gmail, Account #1 for Drive)
- Quick account switching with keyboard shortcuts (Alt+1 through Alt+9)
- Supports 50+ Google services

## Installation

### Chrome
1. Download `default-account-plus-chromium-2.1.3.zip` from the [latest release](https://github.com/Adiker/default.wtf/releases/latest) and extract it to a permanent folder
2. Open `chrome://extensions/` in Chrome or `brave://extensions/` in Brave
3. Enable "Developer mode"
4. Click "Load unpacked" and select the extracted folder containing `manifest.json`

When updating, replace the files in that folder and click the extension's Reload button. The Chromium release ZIP preserves the original extension ID so the existing account preferences can be retained. GitHub releases on this fork do not publish to the Chrome Web Store.

### Firefox
1. Rename `manifest_firefox.json` to `manifest.json` (backup the Chrome one first)
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `manifest.json`

## Account switching

Saving a per-service rule immediately switches the current tab when it belongs to that service. Existing `/u/N/` account routes are rewritten when switching from the extension, so Gmail, Calendar, Drive, and other services open the chosen account while preserving their current view.

Defaults replace the `authuser` query parameter with the configured account, including links such as `https://meet.google.com/home?authuser=1`. Per-service rules take precedence over the global default. Explicit `/u/N/` paths keep their selected account, allowing path-based switching without redirect loops.

## Development tests

```sh
npm ci
npm test
BROWSER_EXECUTABLE=/path/to/brave npm run test:browser
```

The browser test launches a disposable headless profile with the unpacked extension and simulated Google responses. It verifies popup rule creation, real browser redirect rules, account switching, rapid settings updates, and account-fetch failures. It does not access an existing browser profile or real Google accounts. Use a Chromium-based executable that supports `--load-extension`.

## Supported Google Services

Calendar, Drive, Gmail, Meet, Docs, Photos, Keep, Chat, Maps, News, Ads, Analytics, Firebase, Cloud Console, Play Store, YouTube, Translate, Classroom, and many more including:
- **New**: Gemini, NotebookLM, Looker Studio, AppSheet

## License

BSD-3-Clause License - see [LICENSE](LICENSE)

## Credits

Original extension by [UpTech Team](https://github.com/uptechteam)
