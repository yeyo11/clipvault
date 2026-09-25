# Contributing to ClipVault

Thanks for helping! Bug reports, feature ideas, translations and pull requests are all welcome.

## Reporting bugs

Open an [issue](https://github.com/yeyo11/clipvault/issues/new/choose) and include:

- Your distribution, GNOME Shell version (`gnome-shell --version`) and session type (`echo $XDG_SESSION_TYPE`).
- Steps to reproduce the problem.
- Relevant logs: run `make logs` (or `journalctl -f -o cat /usr/bin/gnome-shell`) while reproducing.

**Do not paste clipboard contents, notes or passwords into issues.**

## Development setup

```bash
git clone https://github.com/yeyo11/clipvault.git
cd clipvault
make install      # builds the zip with `gnome-extensions pack` and installs it
```

After each change, run `make install` again and restart GNOME Shell. On X11 use <kbd>Alt</kbd>+<kbd>F2</kbd> → `r`.
On Wayland, test in a nested session instead of logging out:

```bash
dbus-run-session -- gnome-shell --nested --wayland      # GNOME 46–48
```

Useful targets:

| Target | What it does |
|---|---|
| `make pack` | Build `clipvault@yeyo11.github.io.shell-extension.zip` (the file uploaded to extensions.gnome.org) |
| `make install` / `make uninstall` | Install or remove the extension for your user |
| `make enable` / `make disable` / `make prefs` | Shortcuts for `gnome-extensions` |
| `make logs` | Follow GNOME Shell logs filtered for ClipVault |
| `make pot` / `make update-po` | Regenerate the translation template and merge it into every `.po` |
| `make lint` | Check translations and the GSettings schema |

## Code layout

```
extension.js     Entry point. Watches the clipboard, registers shortcuts, simulates paste,
                 manages the top bar icon and the Super+V takeover.
lib/popup.js     The popup UI: tabs, search, history/notes lists, note/account editor
                 and all keyboard handling.
lib/store.js     Persistence of history, images and notes (~/.local/share/clipvault).
lib/secrets.js   Account passwords in the GNOME Keyring (libsecret) and the password generator.
prefs.js         Preferences window (libadwaita).
stylesheet.css   Popup styles (all classes are prefixed with `cv-`).
schemas/         GSettings schema.
po/              Translations.
```

A few design notes:

- **The popup is built on open and destroyed on close.** It takes a modal grab (`Main.pushModal`) and
  handles keys in the backdrop's `captured-event`, so arrows, Enter and Esc work while the search
  entry keeps focus.
- **Pasting** closes the popup, waits ~80 ms for focus to return to the previous window, then sends
  <kbd>Shift</kbd>+<kbd>Insert</kbd> (or <kbd>Ctrl</kbd>+<kbd>V</kbd>) through a Clutter virtual keyboard.
- **Passwords never touch `notes.json`** while libsecret is available, and are excluded from history
  through `useText(..., {record: false})`.
- Writes to disk are debounced and flushed synchronously in `disable()`.

## Code style

- Follow the style of the surrounding code: 4-space indentation, single quotes, ES modules, and
  GJS/GNOME Shell conventions.
- Keep the [GNOME extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
  in mind: create objects in `enable()`, destroy them and disconnect every signal and timeout
  in `disable()`, and never block the Shell's main loop.
- Wrap every user-visible string in `_()`.

## Translations

1. Run `make pot` to refresh `po/clipvault.pot`.
2. Create your language file, for example French:
   `msginit --locale=fr --input=po/clipvault.pot --output-file=po/fr.po`
3. Translate it with a tool such as [Poedit](https://poedit.net/) or GNOME Translation Editor.
4. Run `make lint` and `make install`, then test with your locale.
5. Open a pull request.

To update an existing translation after strings change, run `make update-po` and fill in the new or fuzzy entries.

## Pull requests

- Keep each PR focused on one thing and describe what you tested (GNOME version, X11/Wayland).
- Update `CHANGELOG.md` under *Unreleased* for user-visible changes.
- Include a screenshot for UI changes.

By contributing you agree that your contributions are licensed under GPL-3.0-or-later.
