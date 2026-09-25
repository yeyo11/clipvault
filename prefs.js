// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Passwords from './lib/passwords.js';

// Group titles/descriptions are Pango markup: "&" or "<Super>" would break them.
function group(title, description = null) {
    const escape = s => GLib.markup_escape_text(s, -1);
    return new Adw.PreferencesGroup({
        title: escape(title),
        ...description ? {description: escape(description)} : {},
    });
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle, use_markup: false});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({
        use_markup: false,
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({
        use_markup: false,
        title,
        model: Gtk.StringList.new(options.map(o => o[1])),
    });
    const sync = () => {
        row.selected = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    return row;
}

function shortcutRow(settings, key, title) {
    const row = new Adw.ActionRow({title, use_markup: false});
    const entry = new Gtk.Entry({
        text: settings.get_strv(key)[0] ?? '',
        valign: Gtk.Align.CENTER,
        width_chars: 18,
        placeholder_text: _('Disabled'),
    });
    const apply = () => {
        const text = entry.text.trim();
        if (text === '') {
            settings.set_strv(key, []);
            entry.remove_css_class('error');
            return;
        }
        const [ok, keyval] = Gtk.accelerator_parse(text);
        if (!ok || keyval === 0) {
            entry.add_css_class('error');
            return;
        }
        entry.remove_css_class('error');
        settings.set_strv(key, [text]);
    };
    entry.connect('activate', apply);
    // The same shortcut can be shown on two pages; keep them in sync.
    const changedId = settings.connect(`changed::${key}`, () => {
        const current = settings.get_strv(key)[0] ?? '';
        if (entry.text.trim() !== current)
            entry.text = current;
    });
    entry.connect('destroy', () => settings.disconnect(changedId));
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', apply);
    entry.add_controller(focus);
    row.add_suffix(entry);
    row.activatable_widget = entry;
    return row;
}

export default class ClipVaultPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);

        // ---------------------------------------------------------------- General
        const general = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        window.add(general);

        const keys = group(_('Keyboard Shortcuts'),
            _('GTK accelerator syntax, e.g. <Super>v or <Control><Alt>h. Applied on Enter or when leaving the field; leave empty to disable.'));
        keys.add(shortcutRow(settings, 'toggle-history', _('Open history')));
        keys.add(shortcutRow(settings, 'toggle-notes', _('Open notes & accounts')));
        keys.add(shortcutRow(settings, 'generate-password', _('Generate a password and paste it')));
        keys.add(switchRow(settings, 'free-super-v', _('Take over Super+V from GNOME'),
            _('GNOME uses Super+V to open the notification list. It is removed there and restored when the extension is disabled.')));
        general.add(keys);

        const behaviour = group(_('Behavior'));
        behaviour.add(switchRow(settings, 'paste-on-select', _('Paste on select'),
            _('When disabled, selecting an item only copies it to the clipboard')));
        behaviour.add(comboRow(settings, 'paste-keys', _('Keys used to paste text'), [
            ['shift-insert', _('Shift+Insert (also works in terminals)')],
            ['ctrl-v', _('Ctrl+V')],
        ]));
        behaviour.add(comboRow(settings, 'popup-position', _('Popup position'), [
            ['caret', _('Next to the text cursor')],
            ['pointer', _('Next to the mouse pointer')],
            ['center', _('Center of the screen')],
        ]));
        behaviour.add(spinRow(settings, 'popup-width', _('Width'), _('pixels'), 300, 1000, 10));
        behaviour.add(spinRow(settings, 'popup-height', _('Height'), _('pixels'), 300, 1200, 10));
        behaviour.add(switchRow(settings, 'show-panel-icon', _('Top bar icon'),
            _('Click: history · right click: notes · middle click: private mode')));
        general.add(behaviour);

        // ---------------------------------------------------------------- History
        const history = new Adw.PreferencesPage({title: _('History'), icon_name: 'edit-paste-symbolic'});
        window.add(history);

        const hGroup = group(_('History'));
        hGroup.add(spinRow(settings, 'history-size', _('Maximum size'), _('Unpinned items to keep'), 5, 2000, 5));
        hGroup.add(spinRow(settings, 'preview-lines', _('Lines shown per item'),
            _('Longer text is cut with “…”'), 1, 20));
        hGroup.add(switchRow(settings, 'save-history', _('Keep history across sessions'),
            _('Save the history to disk so it survives restarts')));
        hGroup.add(switchRow(settings, 'save-images', _('Save images')));
        hGroup.add(spinRow(settings, 'max-image-size', _('Maximum image size'), _('MiB'), 1, 100));
        history.add(hGroup);

        const privacy = group(_('Privacy'));
        privacy.add(switchRow(settings, 'private-mode', _('Private mode'), _('Do not record anything that is copied')));
        privacy.add(switchRow(settings, 'ignore-sensitive', _('Ignore secret content'),
            _('Honor the hint set by password managers such as KeePassXC when they copy a password')));
        history.add(privacy);

        // -------------------------------------------------------------- Passwords
        window.add(this._passwordsPage(settings));

        // --------------------------------------------------------------- Accounts
        const accounts = new Adw.PreferencesPage({title: _('Accounts'), icon_name: 'avatar-default-symbolic'});
        window.add(accounts);

        const aGroup = group(_('Notes & Accounts'),
            _('Passwords are stored encrypted in the GNOME Keyring (Passwords and Keys / Seahorse). Titles, usernames and notes are stored in the data folder.'));
        aGroup.add(spinRow(settings, 'clear-secret-seconds', _('Clear copied passwords after'),
            _('seconds (0 = never)'), 0, 3600, 5));

        const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipvault']);
        const openRow = new Adw.ActionRow({title: _('Data folder'), subtitle: dataDir, use_markup: false});
        const openButton = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER});
        openButton.add_css_class('flat');
        openButton.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(dataDir, null), null);
        });
        openRow.add_suffix(openButton);
        aGroup.add(openRow);
        accounts.add(aGroup);

        const about = group(_('About'));
        const repoRow = new Adw.ActionRow({
            use_markup: false,
            title: this.metadata.name,
            subtitle: _('Version %s · Report issues and contribute on GitHub').format(this.metadata['version-name'] ?? this.metadata.version),
            activatable: true,
        });
        repoRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        repoRow.connect('activated', () => Gio.AppInfo.launch_default_for_uri(this.metadata.url, null));
        about.add(repoRow);
        accounts.add(about);
    }

    _passwordsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Passwords'), icon_name: 'dialog-password-symbolic'});

        const generator = group(_('Password Generator'),
            _('Used by the shortcut, the key button in the popup and the account editor. Passwords come from a cryptographic random source and include at least one character of every enabled type.'));
        generator.add(shortcutRow(settings, 'generate-password', _('Shortcut')));
        generator.add(spinRow(settings, 'password-length', _('Length'), _('characters'), 4, 128));
        generator.add(switchRow(settings, 'password-uppercase', _('Uppercase letters'), 'A–Z'));
        generator.add(switchRow(settings, 'password-lowercase', _('Lowercase letters'), 'a–z'));
        generator.add(switchRow(settings, 'password-digits', _('Digits'), '0–9'));

        const symbols = new Adw.ExpanderRow({
            title: _('Symbols'),
            show_enable_switch: true,
            expanded: true,
            use_markup: false,
        });
        settings.bind('password-symbols', symbols, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        const symbolSet = new Adw.EntryRow({title: _('Allowed symbols'), use_markup: false});
        settings.bind('password-symbol-set', symbolSet, 'text', Gio.SettingsBindFlags.DEFAULT);
        const resetSymbols = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Restore the default symbols'),
        });
        resetSymbols.add_css_class('flat');
        resetSymbols.connect('clicked', () => settings.reset('password-symbol-set'));
        symbolSet.add_suffix(resetSymbols);
        symbols.add_row(symbolSet);
        generator.add(symbols);

        generator.add(switchRow(settings, 'password-exclude-ambiguous', _('Avoid look-alike characters'),
            _('Leaves out characters that are easy to confuse, like 0 and O or 1, l and I')));
        page.add(generator);

        // Live preview that follows the options above.
        const previewGroup = group(_('Preview'));
        const preview = new Adw.ActionRow({use_markup: false});
        preview.add_css_class('property');
        const sample = new Gtk.Label({
            selectable: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.CHAR,
            xalign: 0,
            hexpand: true,
        });
        sample.add_css_class('monospace');
        sample.add_css_class('title-4');
        preview.add_prefix(sample);
        const regenerate = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Generate another one'),
        });
        regenerate.add_css_class('flat');
        preview.add_suffix(regenerate);
        const strength = new Gtk.Label({xalign: 0, margin_start: 12, margin_top: 6});
        strength.add_css_class('dim-label');

        const refresh = () => {
            const options = Passwords.optionsFromSettings(settings);
            sample.label = Passwords.generatePassword(options);
            const bits = Passwords.entropyBits(options);
            let level;
            if (bits < 50)
                level = _('Weak');
            else if (bits < 75)
                level = _('Fair');
            else if (bits < 100)
                level = _('Strong');
            else
                level = _('Very strong');
            strength.label = _('Strength: %s (about %d bits of entropy)').format(level, bits);
        };
        regenerate.connect('clicked', refresh);
        const keys = ['password-length', 'password-uppercase', 'password-lowercase', 'password-digits',
            'password-symbols', 'password-symbol-set', 'password-exclude-ambiguous'];
        const ids = keys.map(k => settings.connect(`changed::${k}`, refresh));
        page.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
        refresh();

        previewGroup.add(preview);
        previewGroup.add(strength);
        page.add(previewGroup);
        return page;
    }
}
