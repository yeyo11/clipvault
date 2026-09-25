// SPDX-License-Identifier: GPL-3.0-or-later
//
// ClipVault: Windows-style (Super+V) clipboard history with a notes and
// accounts vault.
//
// Some techniques come from SUPERCILEX/gnome-clipboard-history (pasting by
// simulating Shift+Insert, listening to Mutter's selection `owner-changed`).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Store} from './lib/store.js';
import {ClipboardPopup, TAB_HISTORY, TAB_NOTES} from './lib/popup.js';
import * as Secrets from './lib/secrets.js';
import {CaretTracker} from './lib/caret.js';

// evdev key codes for the virtual keyboard
const KEY_SHIFT_L = 42;
const KEY_CTRL_L = 29;
const KEY_INSERT = 110;
const KEY_V = 47;

const PASTE_DELAY_MS = 80;
const SENSITIVE_MIME = 'x-kde-passwordManagerHint';
const TEXT_MIMES = ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'STRING', 'TEXT'];

export default class ClipVaultExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.store = new Store(this.settings);
        this._clipboard = St.Clipboard.get_default();
        this._caret = new CaretTracker();
        this._popup = new ClipboardPopup(this);
        this._timeouts = new Set();
        this._ignoredText = null;

        this._freeSuperV();
        this._keybindings = [];
        this._bind('toggle-history', () => this._popup.toggle(TAB_HISTORY));
        this._bind('toggle-notes', () => this._popup.toggle(TAB_NOTES));

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onClipboardChanged();
        });

        this._settingsIds = [
            this.settings.connect('changed::show-panel-icon', () => this._syncIndicator()),
            this.settings.connect('changed::private-mode', () => this._syncIndicator()),
            this.settings.connect('changed::history-size', () => this.store.trim()),
            this.settings.connect('changed::free-super-v', () => {
                if (this.settings.get_boolean('free-super-v'))
                    this._freeSuperV();
                else
                    this._restoreSuperV();
            }),
        ];
        this._syncIndicator();
    }

    disable() {
        this._popup.destroy();
        this._popup = null;
        this._caret.destroy();
        this._caret = null;

        this._settingsIds.forEach(id => this.settings.disconnect(id));
        this._settingsIds = null;

        this._selection.disconnect(this._ownerChangedId);
        this._selection = null;

        this._keybindings.forEach(name => Main.wm.removeKeybinding(name));
        this._keybindings = null;
        this._restoreSuperV();

        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = null;

        this._indicator?.destroy();
        this._indicator = null;

        this.store.destroy();
        this.store = null;
        this._clipboard = null;
        this._virtualKeyboard = null;
        this.settings = null;
    }

    // -------------------------------------------------------------- shortcuts

    _bind(name, callback) {
        Main.wm.addKeybinding(name, this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.ALL, callback);
        this._keybindings.push(name);
    }

    /**
     * GNOME binds Super+V to the notification list. If one of our shortcuts
     * matches, remove it there and remember it so disable() can restore it.
     */
    _freeSuperV() {
        if (!this.settings.get_boolean('free-super-v'))
            return;
        const norm = a => a.toLowerCase().replace(/\s/g, '');
        const ours = [...this.settings.get_strv('toggle-history'), ...this.settings.get_strv('toggle-notes')].map(norm);
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const current = shell.get_strv('toggle-message-tray');
        const removed = current.filter(a => ours.includes(norm(a)));
        if (!removed.length)
            return;
        shell.set_strv('toggle-message-tray', current.filter(a => !removed.includes(a)));
        const saved = new Set([...this.settings.get_strv('removed-message-tray-bindings'), ...removed]);
        this.settings.set_strv('removed-message-tray-bindings', [...saved]);
    }

    _restoreSuperV() {
        const removed = this.settings.get_strv('removed-message-tray-bindings');
        if (!removed.length)
            return;
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const current = shell.get_strv('toggle-message-tray');
        shell.set_strv('toggle-message-tray', [...current, ...removed.filter(a => !current.includes(a))]);
        this.settings.set_strv('removed-message-tray-bindings', []);
    }

    // -------------------------------------------------------------- indicator

    _syncIndicator() {
        const show = this.settings.get_boolean('show-panel-icon');
        if (!show) {
            this._indicator?.destroy();
            this._indicator = null;
            return;
        }
        if (!this._indicator) {
            this._indicator = new PanelMenu.Button(0.5, this.metadata.name, true);
            this._indicatorIcon = new St.Icon({style_class: 'system-status-icon'});
            this._indicator.add_child(this._indicatorIcon);
            this._indicator.connect('button-press-event', (_a, event) => {
                // Middle click toggles private mode
                if (event.get_button() === Clutter.BUTTON_MIDDLE)
                    this.settings.set_boolean('private-mode', !this.settings.get_boolean('private-mode'));
                else
                    this._popup.toggle(event.get_button() === Clutter.BUTTON_SECONDARY ? TAB_NOTES : TAB_HISTORY, 'pointer');
                return Clutter.EVENT_STOP;
            });
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        }
        this._indicatorIcon.icon_name = this.settings.get_boolean('private-mode')
            ? 'view-conceal-symbolic'
            : 'edit-paste-symbolic';
    }

    // -------------------------------------------------------------- clipboard

    _onClipboardChanged() {
        if (this.settings.get_boolean('private-mode'))
            return;
        const mimes = this._clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (this.settings.get_boolean('ignore-sensitive') && mimes.includes(SENSITIVE_MIME))
            return;

        if (mimes.some(m => TEXT_MIMES.includes(m) || m.startsWith('text/plain'))) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (!this.store || !text)
                    return;
                if (this._ignoredText !== null && text === this._ignoredText)
                    return;
                this._ignoredText = null;
                this.store.addText(text);
            });
            return;
        }

        if (this.settings.get_boolean('save-images') && mimes.includes('image/png')) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_c, bytes) => {
                if (!this.store || !bytes)
                    return;
                const size = bytes.get_size();
                if (size === 0 || size > this.settings.get_int('max-image-size') * 1024 * 1024)
                    return;
                this.store.addImage(bytes);
            });
        }
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _sendPaste(image) {
        const useCtrlV = image || this.settings.get_string('paste-keys') === 'ctrl-v';
        const [mod, key] = useCtrlV ? [KEY_CTRL_L, KEY_V] : [KEY_SHIFT_L, KEY_INSERT];
        // Give focus time to return to the previous window after the modal closes.
        this._timeout(PASTE_DELAY_MS, () => {
            this._virtualKeyboard ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = GLib.get_monotonic_time();
            this._virtualKeyboard.notify_key(t, mod, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_key(t, key, Clutter.KeyState.PRESSED);
            this._virtualKeyboard.notify_key(t, key, Clutter.KeyState.RELEASED);
            this._virtualKeyboard.notify_key(t, mod, Clutter.KeyState.RELEASED);
        });
    }

    // -------------------------------------------------------- API for popup

    /** Caret rectangle of the focused text field, or null. */
    get caretRect() {
        return this._caret.rect;
    }

    /**
     * Puts text on the clipboard and optionally pastes it.
     * @param {object} opts
     * @param {boolean} opts.paste     simulate a paste (if enabled in settings)
     * @param {boolean} opts.record    add it to the history
     * @param {boolean} opts.sensitive clear it from the clipboard after N seconds
     */
    useText(text, {paste = true, record = true, sensitive = false} = {}) {
        this._popup.close();
        if (!text)
            return;
        this._ignoredText = record ? null : text;
        // PRIMARY too: in terminals Shift+Insert pastes the primary selection.
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._clipboard.set_text(St.ClipboardType.PRIMARY, text);

        if (paste && this.settings.get_boolean('paste-on-select'))
            this._sendPaste(false);

        const seconds = this.settings.get_int('clear-secret-seconds');
        if (sensitive && seconds > 0) {
            this._timeout(seconds * 1000, () => {
                for (const type of [St.ClipboardType.CLIPBOARD, St.ClipboardType.PRIMARY]) {
                    this._clipboard.get_text(type, (_c, current) => {
                        if (current === text)
                            this._clipboard.set_text(type, '');
                    });
                }
            });
        }
    }

    useImage(item, {paste = true} = {}) {
        this._popup.close();
        let bytes;
        try {
            bytes = this.store.loadImage(item);
        } catch (e) {
            Main.notifyError(this.metadata.name, _('Could not load the image: %s').format(e.message));
            return;
        }
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
        if (paste && this.settings.get_boolean('paste-on-select'))
            this._sendPaste(true);
    }

    async useSecret(note, {paste = true} = {}) {
        this._popup.close();
        let password;
        try {
            password = await Secrets.lookupPassword(note);
        } catch (e) {
            Main.notifyError(this.metadata.name, _('Could not read the password from the keyring: %s').format(e.message));
            return;
        }
        if (!this.store)
            return;
        if (!password) {
            Main.notify(this.metadata.name, _('“%s” has no saved password').format(note.title || note.username));
            return;
        }
        this.useText(password, {paste, record: false, sensitive: true});
    }
}
