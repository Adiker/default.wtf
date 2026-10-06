# Privacy Policy

**Last updated: October 6, 2026**

## Overview

Default Account+ for Google ("the Extension") is committed to protecting your privacy. This privacy policy explains how the Extension handles your data.

## Data Collection

The extension reads your Google account list to let you choose an account. It caches account names, email addresses, profile-image URLs, account numbers, and sign-in status in your browser's `chrome.storage.sync`, together with your account preferences. If browser sync is enabled, this storage may be synchronized by your browser's sync service.

## What the Extension Does

The extension stores:
- Your default Google account selection
- Per-service account preferences (e.g., which account to use for Gmail vs Drive)
- The cached Google account list used by the account picker

This data is stored using Chrome's built-in `chrome.storage.sync` API and is:
- Stored locally on your device
- Synced to your own browser profile if browser sync is enabled
- Not sent to the extension author or to analytics or advertising services

To refresh the account list, the extension requests `https://accounts.google.com/ListAccounts` using your existing Google session. It also navigates Google services to the account you select. It does not export your session cookies or store passwords.

## Permissions Explained

- **tabs**: Used to detect which Google service you're visiting
- **storage**: Used to save your account preferences locally
- **declarativeNetRequest**: Used to redirect URLs to your preferred account
- **host_permissions (*.google.com)**: Required to apply your preferences on Google services

## Third-Party Services

The Extension does not integrate with any third-party analytics, advertising, or tracking services.

## Changes to This Policy

Any changes to this privacy policy will be posted in the Extension's GitHub repository.

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/Adiker/default.wtf/issues

## Open Source

This Extension is open source. You can review the complete source code at:
https://github.com/Adiker/default.wtf
