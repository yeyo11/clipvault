# Releasing ClipVault

Checklist for maintainers.

## 1. Prepare the version

1. Make sure `main` is green in CI and has been tried on a real session. Wayland and X11 both matter,
   because pasting and caret tracking differ between them.
2. Bump `version-name` in `metadata.json` (semantic versioning: `1.2.0`, `1.2.1`…).
   Do **not** add a `version` field: extensions.gnome.org assigns that number itself.
3. In `CHANGELOG.md`, rename *Unreleased* to the new version and date, add a new empty
   *Unreleased* section, and update the compare links at the bottom.
4. Run `make update-po`, check that `po/*.po` have no untranslated or fuzzy strings, then run `make lint`.
5. Commit: `git commit -am "Release X.Y.Z"`.

## 2. Publish on GitHub

```bash
git tag -a vX.Y.Z -m "ClipVault X.Y.Z"
git push origin main vX.Y.Z
```

The *Release* workflow (`.github/workflows/release.yml`):
- checks the tag matches `version-name`,
- builds `clipvault@yeyo11.github.io.shell-extension.zip`,
- creates the GitHub release, using the version's CHANGELOG section as release notes.

Users who installed from the release zip update with the same `wget` + `gnome-extensions install --force`
commands, because `releases/latest/download/…` always points to the newest release.

## 3. Publish on extensions.gnome.org (EGO)

1. Download the zip from the GitHub release. That way the reviewed file is exactly what was
   released. Alternatively, build it with `make pack`.
2. Sign in at <https://extensions.gnome.org> and open <https://extensions.gnome.org/upload/>.
3. Upload the zip, accept the license terms (GPL-compatible), and submit.
4. Wait for the manual review, which usually takes from a few days to a couple of weeks. If
   the reviewer asks for changes, fix them, bump the patch version and upload again.
5. After the **first** approval: add a screenshot on the extension page
   (`docs/screenshots/caret.png` or `history.png` work well), and replace "Pending review" in the
   README with the link to the EGO page.

Users who installed from EGO get later versions automatically.

### Notes for the reviewer

Paste this in the upload form's notes field, or as a comment if the reviewer asks:

> - **Super+V**: GNOME binds `<Super>v` to `toggle-message-tray` in `org.gnome.shell.keybindings`.
>   When our shortcut uses the same key, `enable()` removes only that binding from the key, remembers
>   it in our own `removed-message-tray-bindings` setting, and `disable()` restores it. Users can turn
>   this off with the `free-super-v` setting.
> - **Pasting** is done like other clipboard managers: after the popup closes, a
>   `Clutter.VirtualInputDevice` sends Shift+Insert (or Ctrl+V, configurable) to the focused window.
> - **Caret position** comes from `IBusManager`'s public `set-cursor-location` signal. For clients
>   that only report relative coordinates, we also connect to the panel service's
>   `set-cursor-location-relative`. That uses the private `_panelService` field, guarded with
>   try/catch, and is disconnected in `disable()`.
> - **Passwords** are stored with libsecret (GNOME Keyring). `gi://Secret` is imported lazily in
>   `enable()`, and nothing is created at module scope.
> - **Clipboard data** is stored only locally in `~/.local/share/clipvault` (`0700`/`0600`). There are no
>   network connections.
> - `lib/passwords.js` has no Shell imports, so `prefs.js` can use it for the live preview.

## Supported GNOME versions

`shell-version` in `metadata.json` lists 46–48. Before adding a new GNOME release, test it in a
nested session (`dbus-run-session -- gnome-shell --nested --wayland`, or `--devkit` on GNOME 49+),
and check the [porting guide](https://gjs.guide/extensions/upgrading/) for that version.
