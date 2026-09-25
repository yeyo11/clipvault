# Security Policy

ClipVault handles sensitive data: clipboard contents and account passwords. Security reports are taken seriously.

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's
[private vulnerability reporting](https://github.com/yeyo11/clipvault/security/advisories/new)
or email **yeyochico@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce,
- the ClipVault and GNOME Shell versions.

You should receive an answer within 7 days.

## Threat model

- Account passwords are stored in the GNOME Keyring through libsecret. They are protected like any other
  secret in your login keyring.
- The clipboard history, images and notes (without passwords) are stored **unencrypted** in
  `~/.local/share/clipvault/`, readable only by your user (`0600`). Any process running as your user
  can read them, just as it can read the live clipboard.
- ClipVault makes no network connections.
