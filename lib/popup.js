// SPDX-License-Identifier: GPL-3.0-or-later
//
// Windows-style (Win+V) popup: clipboard history + notes/accounts.
//
// Built on open and destroyed on close. While open it holds a modal grab;
// keyboard input is handled in the backdrop's `captured-event` so arrows,
// Enter and Esc can be intercepted before the search entry consumes them.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Secrets from './secrets.js';

export const TAB_HISTORY = 'history';
export const TAB_NOTES = 'notes';

const PREVIEW_LINES = 4;
const PREVIEW_LINE_CHARS = 160;
const CONFIRM_TIMEOUT_MS = 3000;

// A function rather than a constant: gettext only works once the extension exists.
function footerText(key) {
    switch (key) {
    case TAB_HISTORY:
        return _('↵ paste · ⇧↵ copy · Ctrl+P pin · Ctrl+S to notes · Del remove');
    case TAB_NOTES:
        return _('↵ paste · Ctrl+U username · Ctrl+N new · Ctrl+E edit · Del remove');
    default:
        return _('Ctrl+S / Ctrl+↵ save · Tab next field · Esc cancel');
    }
}

function previewText(text) {
    return text
        .replace(/\t/g, '    ')
        .split('\n')
        .filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1))
        .slice(0, PREVIEW_LINES)
        .map(l => (l.length > PREVIEW_LINE_CHARS ? `${l.slice(0, PREVIEW_LINE_CHARS)}…` : l))
        .join('\n')
        .trim();
}

function firstLine(text) {
    const line = (text ?? '').split('\n').find(l => l.trim()) ?? '';
    return line.length > 80 ? `${line.slice(0, 80)}…` : line.trim();
}

function timeAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60)
        return _('now');
    if (s < 3600)
        return _('%d min').format(Math.floor(s / 60));
    if (s < 86400)
        return _('%d h').format(Math.floor(s / 3600));
    if (s < 7 * 86400)
        return _('%d d').format(Math.floor(s / 86400));
    return new Date(ms).toLocaleDateString();
}

function iconButton(iconName, styleClass = '') {
    return new St.Button({
        style_class: `cv-icon-button ${styleClass}`,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName, icon_size: 14}),
    });
}

function textButton(label, styleClass = '') {
    return new St.Button({
        style_class: `cv-text-button ${styleClass}`,
        label,
        can_focus: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function isKey(sym, ...names) {
    return names.some(n => sym === Clutter[`KEY_${n}`]);
}

export class ClipboardPopup {
    /**
     * @param {object} ctrl controller (extension.js): store, settings,
     *   useText(), useImage(), useSecret(), openPreferences()
     */
    constructor(ctrl) {
        this._ctrl = ctrl;
        this._backdrop = null;
        this._timeouts = new Set();
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    /** @param {string} [position] overrides the popup-position setting */
    toggle(tab, position) {
        if (this.isOpen) {
            if (tab !== this._tab && this._mode === 'list')
                this._switchTab(tab);
            else
                this.close();
            return;
        }
        this.open(tab, position);
    }

    open(tab = TAB_HISTORY, position = null) {
        if (this.isOpen)
            return;
        this._position = position;
        this._tab = tab;
        this._mode = 'list';
        this._selectedId = null;
        this._pendingDelete = null;
        this._build();

        Main.uiGroup.add_child(this._backdrop);
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(this._grab);
            this._grab = null;
            this._destroyActors();
            return;
        }

        const store = this._ctrl.store;
        this._storeIds = [
            store.connect('history-changed', () => this._tab === TAB_HISTORY && this._refresh()),
            store.connect('notes-changed', () => this._tab === TAB_NOTES && this._refresh()),
        ];

        this._switchTab(tab);
        this._box.opacity = 0;
        this._box.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close() {
        if (!this.isOpen)
            return;
        this._storeIds?.forEach(id => this._ctrl.store.disconnect(id));
        this._storeIds = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._destroyActors();
    }

    destroy() {
        this.close();
    }

    _destroyActors() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._backdrop?.destroy();
        this._backdrop = null;
        this._rows = [];
    }

    _timeout(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    // ------------------------------------------------------------------ build

    _build() {
        const settings = this._ctrl.settings;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this._backdrop = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', (_a, event) => {
            if (!this._isInsideBox(event))
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });
        this._backdrop.connect('captured-event', (_a, event) => this._onCapturedEvent(event));

        this._box = new St.BoxLayout({vertical: true, style_class: 'cv-popup', reactive: true});
        this._backdrop.add_child(this._box);

        // Header: tabs + actions
        const header = new St.BoxLayout({style_class: 'cv-header'});
        this._tabButtons = {
            [TAB_HISTORY]: this._makeTab('edit-paste-symbolic', _('History'), TAB_HISTORY),
            [TAB_NOTES]: this._makeTab('accessories-text-editor-symbolic', _('Notes & Accounts'), TAB_NOTES),
        };
        header.add_child(this._tabButtons[TAB_HISTORY]);
        header.add_child(this._tabButtons[TAB_NOTES]);
        header.add_child(new St.Widget({x_expand: true}));

        this._addButton = iconButton('list-add-symbolic');
        this._addButton.connect('clicked', () => this._openEditor(null));
        this._clearButton = iconButton('edit-clear-all-symbolic');
        this._clearButton.connect('clicked', () => this._clearHistory());
        this._privateButton = iconButton('view-conceal-symbolic', 'cv-toggle');
        this._privateButton.connect('clicked', () => {
            settings.set_boolean('private-mode', !settings.get_boolean('private-mode'));
            this._syncPrivate();
            this._refresh();
        });
        const prefsButton = iconButton('emblem-system-symbolic');
        prefsButton.connect('clicked', () => {
            this.close();
            this._ctrl.openPreferences();
        });
        [this._addButton, this._clearButton, this._privateButton, prefsButton]
            .forEach(b => header.add_child(b));
        this._box.add_child(header);

        // Search
        this._search = new St.Entry({
            style_class: 'cv-search',
            hint_text: _('Search…'),
            can_focus: true,
            x_expand: true,
        });
        this._search.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'cv-search-icon'}));
        this._search.clutter_text.connect('text-changed', () => {
            this._selectedId = null;
            this._refresh();
        });
        this._box.add_child(this._search);

        // Swappable content (list / editor)
        this._content = new St.BoxLayout({vertical: true, y_expand: true, x_expand: true});
        this._box.add_child(this._content);

        this._scroll = new St.ScrollView({
            style_class: 'cv-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._list = new St.BoxLayout({vertical: true, style_class: 'cv-list', x_expand: true});
        this._scroll.add_child(this._list);
        this._content.add_child(this._scroll);

        this._footer = new St.Label({style_class: 'cv-footer', x_expand: true});
        this._footer.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._box.add_child(this._footer);

        this._syncPrivate();

        this._place(scale);
    }

    /**
     * Positions the popup. Like Windows, it prefers to open right below the
     * text caret (or above it when there is no room), then falls back to the
     * mouse pointer, or the screen center if configured so.
     */
    _place(scale) {
        const settings = this._ctrl.settings;
        const mode = this._position ?? settings.get_string('popup-position');
        const gap = 6 * scale;

        let anchor = null; // {x, y, width, height, centered}
        if (mode === 'caret') {
            const caret = this._ctrl.caretRect;
            if (caret)
                anchor = {...caret, centered: false};
        }
        if (!anchor && mode !== 'center') {
            const [px, py] = global.get_pointer();
            anchor = {x: px, y: py, width: 0, height: 0, centered: true};
        }

        const monitor = anchor ? this._monitorAt(anchor.x, anchor.y) : global.display.get_current_monitor();
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const margin = 8 * scale;
        const w = Math.min(settings.get_int('popup-width') * scale, wa.width - 2 * margin);
        const h = Math.min(settings.get_int('popup-height') * scale, wa.height - 2 * margin);

        let x, y;
        if (anchor) {
            x = anchor.centered ? anchor.x - w / 2 : anchor.x - 12 * scale;
            const below = anchor.y + anchor.height + gap;
            const above = anchor.y - h - gap;
            const bottom = wa.y + wa.height - margin;
            if (below + h <= bottom)
                y = below;
            else if (above >= wa.y + margin)
                y = above;
            else // Fits neither way: use whichever side has more room.
                y = bottom - below > anchor.y - wa.y ? below : above;
        } else {
            x = wa.x + (wa.width - w) / 2;
            y = wa.y + (wa.height - h) / 2;
        }
        x = Math.max(wa.x + margin, Math.min(x, wa.x + wa.width - w - margin));
        y = Math.max(wa.y + margin, Math.min(y, wa.y + wa.height - h - margin));
        this._box.set_position(Math.round(x), Math.round(y));
        this._box.set_size(Math.round(w), Math.round(h));
    }

    _monitorAt(x, y) {
        const index = Main.layoutManager.monitors.findIndex(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return index >= 0 ? index : global.display.get_current_monitor();
    }

    _makeTab(iconName, label, tab) {
        const box = new St.BoxLayout({style_class: 'cv-tab-box'});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({style_class: 'cv-tab', child: box, can_focus: false});
        button.connect('clicked', () => {
            if (this._mode === 'editor')
                this._closeEditor();
            this._switchTab(tab);
        });
        return button;
    }

    _isInsideBox(event) {
        const [ex, ey] = event.get_coords();
        const [bx, by] = this._box.get_transformed_position();
        const [bw, bh] = this._box.get_transformed_size();
        return ex >= bx && ex <= bx + bw && ey >= by && ey <= by + bh;
    }

    _syncPrivate() {
        const on = this._ctrl.settings.get_boolean('private-mode');
        if (on)
            this._privateButton.add_style_pseudo_class('checked');
        else
            this._privateButton.remove_style_pseudo_class('checked');
    }

    _switchTab(tab) {
        this._tab = tab;
        this._selectedId = null;
        this._pendingDelete = null;
        for (const [t, button] of Object.entries(this._tabButtons)) {
            if (t === tab)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._addButton.visible = tab === TAB_NOTES;
        this._clearButton.visible = tab === TAB_HISTORY;
        this._search.set_text('');
        this._refresh();
        global.stage.set_key_focus(this._search);
    }

    _setFooter(text, flash = false) {
        this._footer.text = text;
        if (flash)
            this._footer.add_style_class_name('cv-footer-flash');
        else
            this._footer.remove_style_class_name('cv-footer-flash');
    }

    _resetFooter() {
        this._setFooter(footerText(this._mode === 'editor' ? 'editor' : this._tab));
    }

    // ------------------------------------------------------------------ list

    _filteredItems() {
        const q = this._search.get_text().trim().toLowerCase();
        const store = this._ctrl.store;
        if (this._tab === TAB_HISTORY) {
            const items = store.history.filter(it =>
                !q || (it.type === 'text' ? it.text.toLowerCase().includes(q) : _('image').toLowerCase().includes(q)));
            return [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)];
        }
        const items = store.notes.filter(n =>
            !q || [n.title, n.content, n.username, n.url].some(f => f?.toLowerCase().includes(q)));
        return [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)];
    }

    _refresh() {
        if (!this.isOpen || this._mode !== 'list')
            return;
        this._list.destroy_all_children();
        this._rows = [];

        const items = this._filteredItems();
        if (items.length === 0) {
            this._list.add_child(new St.Label({style_class: 'cv-empty', text: this._emptyText(), x_expand: true}));
        }
        for (const item of items) {
            const row = this._tab === TAB_HISTORY ? this._historyRow(item) : this._noteRow(item);
            const index = this._rows.length;
            row.connect('motion-event', () => {
                if (this._selectedIndex !== index)
                    this._select(index, false);
                return Clutter.EVENT_PROPAGATE;
            });
            row.connect('clicked', () => this._activate(item, {paste: true}));
            this._list.add_child(row);
            this._rows.push({row, item});
        }

        const idx = Math.max(0, this._rows.findIndex(r => r.item.id === this._selectedId));
        this._selectedIndex = -1;
        if (this._rows.length)
            this._select(idx, true);
        this._resetFooter();
    }

    _emptyText() {
        if (this._search.get_text().trim())
            return _('No results');
        if (this._tab === TAB_NOTES)
            return _('No notes or accounts yet.\nPress + or Ctrl+N to create one.');
        if (this._ctrl.settings.get_boolean('private-mode'))
            return _('Private mode is on: nothing is being recorded.');
        return _('Your clipboard history is empty.\nCopy something with Ctrl+C.');
    }

    _select(index, scroll = true) {
        if (index < 0 || index >= this._rows.length)
            return;
        this._rows[this._selectedIndex]?.row.remove_style_pseudo_class('selected');
        this._selectedIndex = index;
        const {row, item} = this._rows[index];
        row.add_style_pseudo_class('selected');
        this._selectedId = item.id;
        if (scroll)
            this._scrollTo(row);
    }

    _scrollTo(row) {
        if (row.has_allocation()) {
            ensureActorVisibleInScrollView(this._scroll, row);
            return;
        }
        // Freshly created: wait until it has a size before scrolling.
        const id = row.connect('notify::allocation', () => {
            row.disconnect(id);
            this._timeout(0, () => {
                if (this._rows[this._selectedIndex]?.row === row)
                    ensureActorVisibleInScrollView(this._scroll, row);
            });
        });
    }

    _selectedItem() {
        return this._rows[this._selectedIndex]?.item ?? null;
    }

    _historyRow(item) {
        const row = new St.Button({style_class: 'cv-row', x_expand: true, can_focus: false});
        const hbox = new St.BoxLayout({style_class: 'cv-row-box', x_expand: true});
        row.set_child(hbox);

        if (item.type === 'text') {
            const label = new St.Label({
                style_class: 'cv-row-text',
                text: previewText(item.text) || _('(whitespace)'),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            hbox.add_child(label);
        } else {
            const uri = GLib.filename_to_uri(this._ctrl.store.imagePath(item.image), null);
            hbox.add_child(new St.Widget({
                style_class: 'cv-thumb',
                style: `background-image: url("${uri}");`,
                x_expand: true,
            }));
        }

        const side = new St.BoxLayout({style_class: 'cv-row-side', y_align: Clutter.ActorAlign.CENTER});
        side.add_child(new St.Label({style_class: 'cv-time', text: timeAgo(item.time), y_align: Clutter.ActorAlign.CENTER}));

        if (item.type === 'text') {
            const save = iconButton('document-save-symbolic');
            save.connect('clicked', () => this._saveAsNote(item));
            side.add_child(save);
        }
        const pin = iconButton('view-pin-symbolic', 'cv-toggle');
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => this._ctrl.store.togglePin(item.id));
        side.add_child(pin);

        const del = iconButton('window-close-symbolic');
        del.connect('clicked', () => this._delete(item));
        side.add_child(del);

        hbox.add_child(side);
        return row;
    }

    _noteRow(note) {
        const row = new St.Button({style_class: 'cv-row', x_expand: true, can_focus: false});
        const hbox = new St.BoxLayout({style_class: 'cv-row-box', x_expand: true});
        row.set_child(hbox);

        const isAccount = note.kind === 'account';
        hbox.add_child(new St.Icon({
            style_class: 'cv-note-icon',
            icon_name: isAccount ? 'dialog-password-symbolic' : 'accessories-text-editor-symbolic',
            icon_size: 20,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = new St.Label({style_class: 'cv-note-title', text: note.title || firstLine(note.content) || _('Untitled')});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(title);
        const subText = isAccount
            ? [note.username, note.url].filter(Boolean).join(' · ')
            : firstLine(note.content);
        if (subText && subText !== title.text) {
            const sub = new St.Label({style_class: 'cv-note-sub', text: subText});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(sub);
        }
        hbox.add_child(texts);

        if (isAccount) {
            // Under the title so the labels never get truncated.
            const actions = new St.BoxLayout({style_class: 'cv-account-actions'});
            if (note.username) {
                const user = textButton(_('Username'));
                user.connect('clicked', () => this._activateUsername(note, {paste: true}));
                actions.add_child(user);
            }
            const pass = textButton(_('Password'));
            pass.connect('clicked', () => this._activate(note, {paste: true}));
            actions.add_child(pass);
            texts.add_child(actions);
        }

        const side = new St.BoxLayout({style_class: 'cv-row-side', y_align: Clutter.ActorAlign.CENTER});
        const pin = iconButton('view-pin-symbolic', 'cv-toggle');
        if (note.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => this._ctrl.store.toggleNotePin(note.id));
        side.add_child(pin);

        const edit = iconButton('document-edit-symbolic');
        edit.connect('clicked', () => this._openEditor(note));
        side.add_child(edit);

        const del = iconButton('user-trash-symbolic');
        if (this._pendingDelete === note.id)
            del.add_style_class_name('cv-danger');
        del.connect('clicked', () => this._delete(note));
        side.add_child(del);

        hbox.add_child(side);
        return row;
    }

    // ---------------------------------------------------------------- actions

    _activate(item, {paste}) {
        if (!item)
            return;
        if (this._tab === TAB_HISTORY) {
            if (item.type === 'text')
                this._ctrl.useText(item.text, {paste});
            else
                this._ctrl.useImage(item, {paste});
        } else if (item.kind === 'account') {
            this._ctrl.useSecret(item, {paste});
        } else {
            this._ctrl.useText(item.content, {paste});
        }
    }

    _activateUsername(note, {paste}) {
        if (note?.kind !== 'account')
            return;
        if (!note.username) {
            this._setFooter(_('This account has no username'), true);
            return;
        }
        this._ctrl.useText(note.username, {paste, record: false});
    }

    _delete(item) {
        if (!item)
            return;
        if (this._tab === TAB_HISTORY) {
            this._ctrl.store.removeHistory(item.id);
            return;
        }
        // Notes/accounts ask for confirmation (press twice).
        if (this._pendingDelete !== item.id) {
            this._pendingDelete = item.id;
            this._selectedId = item.id;
            this._refresh();
            this._setFooter(_('Press again to delete permanently'), true);
            this._timeout(CONFIRM_TIMEOUT_MS, () => {
                if (this._pendingDelete === item.id) {
                    this._pendingDelete = null;
                    this._refresh();
                }
            });
            return;
        }
        this._pendingDelete = null;
        if (item.kind === 'account')
            Secrets.clearPassword(item).catch(e => console.error(e));
        this._ctrl.store.removeNote(item.id);
    }

    _clearHistory() {
        if (!this._pendingClear) {
            this._pendingClear = true;
            this._clearButton.add_style_class_name('cv-danger');
            this._setFooter(_('Press again to clear the history (pinned items are kept)'), true);
            this._timeout(CONFIRM_TIMEOUT_MS, () => {
                this._pendingClear = false;
                this._clearButton?.remove_style_class_name('cv-danger');
                this._resetFooter();
            });
            return;
        }
        this._pendingClear = false;
        this._clearButton.remove_style_class_name('cv-danger');
        this._ctrl.store.clearHistory();
    }

    _saveAsNote(item) {
        if (item?.type !== 'text')
            return;
        this._switchTab(TAB_NOTES);
        this._openEditor(null, {kind: 'note', title: firstLine(item.text).slice(0, 60), content: item.text});
    }

    // ----------------------------------------------------------------- editor

    _openEditor(note, preset = {}) {
        if (this._tab !== TAB_NOTES)
            this._switchTab(TAB_NOTES);
        this._mode = 'editor';
        this._editing = note;
        this._editorKind = note?.kind ?? preset.kind ?? 'note';
        this._passwordLoaded = !note || note.kind !== 'account';
        this._search.reactive = false;
        this._search.opacity = 128;

        this._content.remove_child(this._scroll);
        this._editorScroll = new St.ScrollView({
            style_class: 'cv-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        const form = new St.BoxLayout({vertical: true, style_class: 'cv-editor', x_expand: true});
        this._editorScroll.add_child(form);
        this._content.add_child(this._editorScroll);

        // Kind
        const kindBox = new St.BoxLayout({style_class: 'cv-kind-box'});
        this._kindButtons = {
            note: textButton(_('Note'), 'cv-kind'),
            account: textButton(_('Account'), 'cv-kind'),
        };
        for (const [kind, button] of Object.entries(this._kindButtons)) {
            button.connect('clicked', () => this._setEditorKind(kind));
            kindBox.add_child(button);
        }
        form.add_child(kindBox);

        const field = (label, entry) => {
            const box = new St.BoxLayout({vertical: true, style_class: 'cv-field'});
            box.add_child(new St.Label({text: label, style_class: 'cv-field-label'}));
            box.add_child(entry);
            form.add_child(box);
            return box;
        };
        const entry = (hint, text = '') => new St.Entry({
            style_class: 'cv-entry', hint_text: hint, text, can_focus: true, x_expand: true,
        });

        this._fTitle = entry(_('e.g. Work email'), note?.title ?? preset.title ?? '');
        field(_('Title'), this._fTitle);

        this._fUser = entry(_('username or email'), note?.username ?? '');
        this._fUserBox = field(_('Username'), this._fUser);

        this._fPass = entry(this._passwordLoaded ? _('password') : _('Loading from keyring…'));
        this._fPass.clutter_text.set_password_char('●');
        const passRow = new St.BoxLayout({style_class: 'cv-pass-row', x_expand: true});
        passRow.add_child(this._fPass);
        const reveal = iconButton('view-reveal-symbolic', 'cv-toggle');
        let hidden = true;
        reveal.connect('clicked', () => {
            hidden = !hidden;
            this._fPass.clutter_text.set_password_char(hidden ? '●' : '');
            if (hidden)
                reveal.remove_style_pseudo_class('checked');
            else
                reveal.add_style_pseudo_class('checked');
        });
        passRow.add_child(reveal);
        const generate = iconButton('view-refresh-symbolic');
        generate.connect('clicked', () => {
            this._passwordLoaded = true;
            this._fPass.set_text(Secrets.generatePassword());
        });
        passRow.add_child(generate);
        this._fPassBox = field(Secrets.available
            ? _('Password (stored in the GNOME Keyring)')
            : _('Password (⚠ no keyring available: stored unencrypted)'), passRow);

        this._fUrl = entry(_('https://… (optional)'), note?.url ?? '');
        this._fUrlBox = field(_('URL'), this._fUrl);

        this._fContent = entry(_('Type here…'), note?.content ?? preset.content ?? '');
        this._fContent.add_style_class_name('cv-multiline');
        this._fContent.y_align = Clutter.ActorAlign.START;
        const ct = this._fContent.clutter_text;
        ct.single_line_mode = false;
        ct.activatable = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // St.Entry centres its text vertically, so the frame provides the
        // minimum height and the entry grows from the top.
        const frame = new St.BoxLayout({style_class: 'cv-multiline-frame', reactive: true, x_expand: true});
        frame.add_child(this._fContent);
        frame.connect('button-press-event', () => {
            global.stage.set_key_focus(this._fContent);
            return Clutter.EVENT_PROPAGATE;
        });
        this._fContentLabelBox = field(_('Content'), frame);

        const buttons = new St.BoxLayout({style_class: 'cv-editor-buttons'});
        buttons.add_child(new St.Widget({x_expand: true}));
        const cancel = textButton(_('Cancel'));
        cancel.connect('clicked', () => this._closeEditor());
        const save = textButton(_('Save'), 'cv-suggested');
        save.connect('clicked', () => this._saveEditor());
        buttons.add_child(cancel);
        buttons.add_child(save);
        form.add_child(buttons);

        this._setEditorKind(this._editorKind);
        this._resetFooter();
        global.stage.set_key_focus(this._fTitle.get_text() ? this._fContent : this._fTitle);

        if (!this._passwordLoaded) {
            const editing = note;
            Secrets.lookupPassword(note).then(pw => {
                if (this._mode !== 'editor' || this._editing !== editing)
                    return;
                this._passwordLoaded = true;
                this._fPass.hint_text = _('password');
                if (!this._fPass.get_text())
                    this._fPass.set_text(pw);
            }).catch(e => {
                if (this._mode === 'editor' && this._editing === editing)
                    this._fPass.hint_text = _('Could not read the keyring');
                console.error(`[clipvault] ${e.message}`);
            });
        }
    }

    _setEditorKind(kind) {
        this._editorKind = kind;
        for (const [k, button] of Object.entries(this._kindButtons)) {
            if (k === kind)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        const isAccount = kind === 'account';
        this._fUserBox.visible = isAccount;
        this._fPassBox.visible = isAccount;
        this._fUrlBox.visible = isAccount;
        this._fContentLabelBox.get_first_child().text = isAccount ? _('Notes') : _('Content');
    }

    _editorFields() {
        return [this._fTitle, this._fUser, this._fPass, this._fUrl, this._fContent]
            .filter(e => e.get_parent().visible && (e.get_parent().get_parent()?.visible ?? true));
    }

    _focusNextField(backwards) {
        const fields = this._editorFields();
        const focus = global.stage.get_key_focus();
        let idx = fields.findIndex(f => f === focus || f.clutter_text === focus);
        idx = (idx + (backwards ? -1 : 1) + fields.length) % fields.length;
        global.stage.set_key_focus(fields[idx]);
    }

    async _saveEditor() {
        const kind = this._editorKind;
        const title = this._fTitle.get_text().trim();
        const content = this._fContent.get_text();
        const username = this._fUser.get_text().trim();
        const password = this._fPass.get_text();
        if (!title && !content.trim() && !(kind === 'account' && username)) {
            this._setFooter(_('Enter at least a title or some content'), true);
            return;
        }
        const note = this._ctrl.store.saveNote({
            id: this._editing?.id,
            kind,
            title,
            content,
            username,
            url: this._fUrl.get_text().trim(),
        });
        try {
            if (kind === 'account' && this._passwordLoaded)
                await Secrets.storePassword(note, password);
            else if (kind === 'note' && this._editing?.kind === 'account')
                await Secrets.clearPassword(note);
            if (!Secrets.available)
                this._ctrl.store.saveNote(note); // persist insecurePassword
        } catch (e) {
            console.error(`[clipvault] ${e.message}`);
            if (this.isOpen)
                this._setFooter(_('Error saving the password: %s').format(e.message), true);
            return;
        }
        if (!this.isOpen)
            return;
        this._closeEditor();
        this._selectedId = note.id;
        this._refresh();
    }

    _closeEditor() {
        if (this._mode !== 'editor')
            return;
        this._mode = 'list';
        this._editing = null;
        this._editorScroll.destroy();
        this._editorScroll = null;
        this._content.add_child(this._scroll);
        this._search.reactive = true;
        this._search.opacity = 255;
        this._refresh();
        global.stage.set_key_focus(this._search);
    }

    // --------------------------------------------------------------- keyboard

    _onCapturedEvent(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ch = String.fromCharCode(Clutter.keysym_to_unicode(sym)).toLowerCase();

        const handled = this._mode === 'editor'
            ? this._onEditorKey(sym, ch, ctrl, shift)
            : this._onListKey(sym, ch, ctrl, shift);
        return handled ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _onEditorKey(sym, ch, ctrl, shift) {
        if (isKey(sym, 'Escape')) {
            this._closeEditor();
        } else if (ctrl && (ch === 's' || isKey(sym, 'Return', 'KP_Enter', 'ISO_Enter'))) {
            this._saveEditor();
        } else if (isKey(sym, 'Tab', 'ISO_Left_Tab')) {
            this._focusNextField(shift || isKey(sym, 'ISO_Left_Tab'));
        } else {
            return false;
        }
        return true;
    }

    _onListKey(sym, ch, ctrl, shift) {
        const item = this._selectedItem();
        const searchEmpty = !this._search.get_text();

        if (isKey(sym, 'Escape')) {
            if (!searchEmpty)
                this._search.set_text('');
            else
                this.close();
        } else if (isKey(sym, 'Down', 'KP_Down')) {
            this._select(Math.min(this._selectedIndex + 1, this._rows.length - 1));
        } else if (isKey(sym, 'Up', 'KP_Up')) {
            this._select(Math.max(this._selectedIndex - 1, 0));
        } else if (isKey(sym, 'Page_Down', 'KP_Page_Down')) {
            this._select(Math.min(this._selectedIndex + 5, this._rows.length - 1));
        } else if (isKey(sym, 'Page_Up', 'KP_Page_Up')) {
            this._select(Math.max(this._selectedIndex - 5, 0));
        } else if (isKey(sym, 'Return', 'KP_Enter', 'ISO_Enter')) {
            this._activate(item, {paste: !shift});
        } else if (isKey(sym, 'Tab', 'ISO_Left_Tab')) {
            this._switchTab(this._tab === TAB_HISTORY ? TAB_NOTES : TAB_HISTORY);
        } else if (isKey(sym, 'Delete', 'KP_Delete') && (searchEmpty || shift)) {
            this._delete(item);
        } else if (ctrl && ch === 'p' && item) {
            if (this._tab === TAB_HISTORY)
                this._ctrl.store.togglePin(item.id);
            else
                this._ctrl.store.toggleNotePin(item.id);
        } else if (ctrl && ch === 's' && this._tab === TAB_HISTORY) {
            this._saveAsNote(item);
        } else if (ctrl && ch === 'n') {
            this._openEditor(null);
        } else if (ctrl && ch === 'e' && this._tab === TAB_NOTES && item) {
            this._openEditor(item);
        } else if (ctrl && ch === 'u' && this._tab === TAB_NOTES) {
            this._activateUsername(item, {paste: !shift});
        } else {
            return false;
        }
        return true;
    }
}
