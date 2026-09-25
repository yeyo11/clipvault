<div align="center">

# ClipVault

**Windows-style clipboard history for GNOME, with a vault for notes and accounts.**

Press <kbd>Super</kbd>+<kbd>V</kbd>, pick what you copied earlier, and it gets pasted into the window you were using.

[![License: GPL v3+](https://img.shields.io/badge/License-GPLv3+-blue.svg)](LICENSE)
![GNOME Shell 46–48](https://img.shields.io/badge/GNOME_Shell-46_|_47_|_48-4a86cf?logo=gnome&logoColor=white)
[![CI](https://github.com/yeyo11/clipvault/actions/workflows/ci.yml/badge.svg)](https://github.com/yeyo11/clipvault/actions/workflows/ci.yml)

<img src="docs/screenshots/history.png" width="360" alt="Clipboard history"> <img src="docs/screenshots/notes.png" width="360" alt="Notes and accounts">

</div>

## Features

**Clipboard history**
- Opens with <kbd>Super</kbd>+<kbd>V</kbd>, next to the mouse pointer or in the center of the screen.
- Records **text and images**, skips duplicates and moves reused items back to the top.
- **Instant search**, full keyboard navigation and **pinned items** that survive "Clear history".
- **Pastes straight into the previous window**. Use <kbd>Shift</kbd>+<kbd>Enter</kbd> to copy without pasting.
- Turn any history item into a saved note with <kbd>Ctrl</kbd>+<kbd>S</kbd>.

**Notes & accounts vault** (<kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>)
- **Notes**: snippets you paste often, such as addresses, commands, templates or Wi-Fi details.
- **Accounts**: title, username, password, URL and notes, with one-click *Username* / *Password* paste buttons.
- **Passwords live in the GNOME Keyring** (libsecret) and are never written to disk in plain text.
- Copied passwords are **cleared from the clipboard after 30 s** and never enter the history.
- Built-in **strong password generator**.

**Privacy**
- **Private mode** stops all recording. Toggle it from the popup, the settings, or by middle-clicking the top bar icon.
- Honors the `x-kde-passwordManagerHint` flag that password managers such as KeePassXC set, so their secrets are never recorded.
- All data stays local, in files readable only by you (`0600`).

**Integration**
- Takes over <kbd>Super</kbd>+<kbd>V</kbd>, which GNOME uses for the notification list, and gives it back when the extension is disabled.
- Top bar icon (optional): left click for history, right click for notes, middle click for private mode.
- Translatable UI. It ships in English and Spanish.

<details>
<summary><b>More screenshots</b></summary>

| Search | Account editor | Preferences |
|---|---|---|
| <img src="docs/screenshots/search.png" width="260"> | <img src="docs/screenshots/account-editor.png" width="260"> | <img src="docs/screenshots/preferences.png" width="260"> |

</details>

## Installation

### From source

Requirements: GNOME Shell 46, 47 or 48, plus `gettext` and `make`. Ubuntu 24.04+ and Fedora 40+ are supported.

```bash
git clone https://github.com/yeyo11/clipvault.git
cd clipvault
make install
```

Then restart GNOME Shell:
- **X11**: press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r` and press <kbd>Enter</kbd>.
- **Wayland**: log out and log back in.

Finally, enable it:

```bash
make enable        # or: gnome-extensions enable clipvault@yeyo11.github.io
```

> **Tip:** disable any other clipboard manager that uses <kbd>Super</kbd>+<kbd>V</kbd> (for example
> `gnome-extensions disable clipboard-indicator@tudmotu.com`).

### From extensions.gnome.org

Not submitted yet. It will be linked here once it has been reviewed.

## Usage

| Key | History tab | Notes & Accounts tab |
|---|---|---|
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Move selection | Move selection |
| <kbd>Enter</kbd> | Paste | Paste note / account password |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Copy only | Copy only |
| <kbd>Ctrl</kbd>+<kbd>U</kbd> | — | Paste account username |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> | Pin / unpin | Pin / unpin |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save item as note | — |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | New note | New note |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | — | Edit |
| <kbd>Del</kbd> | Remove (when search is empty; <kbd>Shift</kbd>+<kbd>Del</kbd> always) | Remove (press twice to confirm) |
| <kbd>Tab</kbd> | Switch to notes | Switch to history |
| <kbd>Esc</kbd> | Clear search, then close | Clear search, then close |

Typing always goes to the search box. In the editor, <kbd>Tab</kbd> moves between fields,
<kbd>Ctrl</kbd>+<kbd>S</kbd> or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves, and <kbd>Esc</kbd> cancels.

## Settings

Open them from the ⚙ button in the popup, from the Extensions app, or with `make prefs`.

| Setting | Default |
|---|---|
| Open history / notes shortcuts | <kbd>Super</kbd>+<kbd>V</kbd> / <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> |
| Take over Super+V from GNOME | On |
| Paste on select | On |
| Keys used to paste text | <kbd>Shift</kbd>+<kbd>Insert</kbd> (works in terminals too) or <kbd>Ctrl</kbd>+<kbd>V</kbd> |
| Popup position / size | Next to pointer, 420×540 |
| History size (unpinned items) | 100 |
| Keep history across sessions / save images / max image size | On / On / 10 MiB |
| Private mode / ignore secret content | Off / On |
| Clear copied passwords after | 30 s |

## Privacy & security

| What | Where |
|---|---|
| History | `~/.local/share/clipvault/history.json` |
| Images | `~/.local/share/clipvault/images/` |
| Notes and account metadata (title, username, URL, notes) | `~/.local/share/clipvault/notes.json` |
| **Account passwords** | **GNOME Keyring**, shown as *"ClipVault: …"* in *Passwords and Keys* (Seahorse) |

- The data directory is `0700` and its files are `0600`.
- Nothing is ever sent over the network.
- If libsecret is not available, which is very unusual on a GNOME desktop, passwords fall back to
  `notes.json` **unencrypted**, and the editor shows a warning.
- The history itself is **not encrypted**. Anything you copy is stored in plain text, as with every
  clipboard manager. Use private mode or a password manager that sets the secret hint for sensitive data.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Troubleshooting

<details>
<summary><b>Super+V does nothing or opens the notification list</b></summary>

Check that *Take over Super+V from GNOME* is enabled and that no other extension binds the same key.
Run `make logs` and press the shortcut to see errors.
</details>

<details>
<summary><b>Selecting an item copies it but does not paste</b></summary>

Some apps ignore <kbd>Shift</kbd>+<kbd>Insert</kbd>. Switch *Keys used to paste text* to <kbd>Ctrl</kbd>+<kbd>V</kbd>.
Images are always pasted with <kbd>Ctrl</kbd>+<kbd>V</kbd>.
</details>

<details>
<summary><b>I get a "keyring" password prompt</b></summary>

Your login keyring is locked. Unlock it with your login password once. ClipVault needs it to read or
save account passwords.
</details>

## Uninstall

```bash
make uninstall
rm -rf ~/.local/share/clipvault                     # history, images and notes
# Account passwords: remove the "ClipVault: …" entries in Passwords and Keys (Seahorse)
```

## Contributing

Bug reports, ideas, translations and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the development setup, code layout and how to add a translation.

## Credits

Some techniques, such as simulating <kbd>Shift</kbd>+<kbd>Insert</kbd> to paste and listening to Mutter's
selection changes, were inspired by
[SUPERCILEX/gnome-clipboard-history](https://github.com/SUPERCILEX/gnome-clipboard-history).
ClipVault's code is written from scratch.

## License

Copyright © 2026 Jose Antonio Garrido.

ClipVault is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE), version 3 or (at your option) any later version.
