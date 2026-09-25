# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-09-25

### Added
- The popup now opens right below the text cursor of the focused field, like Windows' Win+V.
  It falls back to the mouse pointer when the app doesn't report its cursor. This is the new default
  "Popup position".
- Opening the popup from the top bar icon always places it next to the mouse pointer.
- Tooltips on every button, showing what it does and its keyboard shortcut.
- Pinned items have their own highlighted "Pinned" section, with an accent edge and tint.
- New "Lines shown per item" setting (1–20, default 4). Longer text ends with "…".
- Password generator shortcut (<kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>) and a 🔑 button in the popup. Both paste
  a new password into the focused field. It is never recorded in the history, and a notification
  offers to save it as an account.
- Configurable password rules: length, uppercase, lowercase, digits, symbols, the allowed
  symbols, and avoiding look-alike characters. A new *Passwords* preferences page shows a
  live preview and strength.

### Fixed
- The ⚙ button did nothing when the preferences window was already open, for example behind
  another window. It now brings that window to the front.
- Preferences group titles and descriptions containing `&` or `<…>` were shown empty.
- Filling in editor fields no longer logs Clutter input-method warnings.

## [1.0.0] - 2026-09-25

### Added
- Windows-style clipboard history popup on <kbd>Super</kbd>+<kbd>V</kbd> for text and images.
- Search, keyboard navigation, pinned items, and remove / clear with confirmation.
- Automatic paste into the previous window (<kbd>Shift</kbd>+<kbd>Insert</kbd> or <kbd>Ctrl</kbd>+<kbd>V</kbd>).
- Notes & accounts vault on <kbd>Super</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>, with passwords stored in the GNOME Keyring.
- Password generator and automatic clearing of copied passwords.
- Save any history item as a note.
- Private mode, and honoring the password-manager secret hint.
- Automatic takeover and restore of GNOME's <kbd>Super</kbd>+<kbd>V</kbd> shortcut.
- Preferences window, optional top bar icon, and English and Spanish translations.

[Unreleased]: https://github.com/yeyo11/clipvault/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/yeyo11/clipvault/compare/0c9e161...v1.1.0
[1.0.0]: https://github.com/yeyo11/clipvault/tree/0c9e161
