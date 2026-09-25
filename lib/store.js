// SPDX-License-Identifier: GPL-3.0-or-later
//
// Persistence for the clipboard history and for notes/accounts.
//
// Everything lives in ~/.local/share/clipvault/ with 0700/0600 permissions:
//   history.json  -> history items (text, or a reference to an image)
//   notes.json    -> notes and accounts (passwords are NOT here, see secrets.js)
//   images/       -> copied images as PNG, named after their SHA-256

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const SAVE_DELAY_MS = 800;
const MAX_TEXT_LENGTH = 512 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function newId() {
    return GLib.uuid_string_random();
}

function readJson(file, fallback) {
    try {
        const [, contents] = file.load_contents(null);
        return JSON.parse(decoder.decode(contents));
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`[clipvault] Could not read ${file.get_path()}: ${e.message}`);
        return fallback;
    }
}

function writeFileAsync(file, bytes) {
    file.replace_contents_bytes_async(
        bytes, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (f, res) => {
            try {
                f.replace_contents_finish(res);
            } catch (e) {
                console.error(`[clipvault] Could not save ${f.get_path()}: ${e.message}`);
            }
        });
}

function writeFileSync(file, bytes) {
    try {
        file.replace_contents(bytes.toArray(), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        console.error(`[clipvault] Could not save ${file.get_path()}: ${e.message}`);
    }
}

export class Store extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;

        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipvault']);
        this._imageDir = GLib.build_filenamev([this._dir, 'images']);
        GLib.mkdir_with_parents(this._imageDir, 0o700);

        this._historyFile = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'history.json']));
        this._notesFile = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'notes.json']));

        this._pending = new Map(); // file -> timeout id

        /** @type {Array<{id, type: 'text'|'image', text?, image?, hash?, pinned, time}>} */
        this.history = [];
        /** @type {Array<{id, kind: 'note'|'account', title, content, username, url, pinned, time}>} */
        this.notes = [];

        this._load();
    }

    _load() {
        if (this._settings.get_boolean('save-history')) {
            const data = readJson(this._historyFile, {items: []});
            this.history = (data.items ?? []).filter(it =>
                it.type === 'text' ? typeof it.text === 'string' : this._imageExists(it.image));
        }
        const notes = readJson(this._notesFile, {items: []});
        this.notes = notes.items ?? [];
        this._removeOrphanImages();
    }

    _removeOrphanImages() {
        const used = new Set(this.history.map(it => it.image).filter(Boolean));
        try {
            const dir = Gio.File.new_for_path(this._imageDir);
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                if (!used.has(info.get_name()))
                    dir.get_child(info.get_name()).delete(null);
            }
            en.close(null);
        } catch (e) {
            console.warn(`[clipvault] Image cleanup failed: ${e.message}`);
        }
    }

    destroy() {
        // Flush pending writes to disk before going away.
        for (const [file, id] of this._pending) {
            GLib.source_remove(id);
            writeFileSync(file, this._serialize(file));
        }
        this._pending.clear();
    }

    // ----------------------------------------------------------------- saving

    _serialize(file) {
        let obj;
        if (file === this._historyFile) {
            obj = {version: 1, items: this._settings.get_boolean('save-history') ? this.history : []};
        } else {
            obj = {version: 1, items: this.notes};
        }
        return new GLib.Bytes(encoder.encode(JSON.stringify(obj)));
    }

    _scheduleSave(file) {
        if (this._pending.has(file))
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._pending.delete(file);
            writeFileAsync(file, this._serialize(file));
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(file, id);
    }

    _historyChanged() {
        this._scheduleSave(this._historyFile);
        this.emit('history-changed');
    }

    _notesChanged() {
        this._scheduleSave(this._notesFile);
        this.emit('notes-changed');
    }

    // ---------------------------------------------------------------- history

    imagePath(name) {
        return GLib.build_filenamev([this._imageDir, name]);
    }

    _imageExists(name) {
        return typeof name === 'string' && GLib.file_test(this.imagePath(name), GLib.FileTest.EXISTS);
    }

    _moveToTop(item) {
        const idx = this.history.indexOf(item);
        if (idx > 0) {
            this.history.splice(idx, 1);
            this.history.unshift(item);
        }
        item.time = Date.now();
    }

    addText(text) {
        if (!text || !text.trim() || text.length > MAX_TEXT_LENGTH)
            return;
        const existing = this.history.find(it => it.type === 'text' && it.text === text);
        if (existing) {
            if (this.history[0] === existing)
                return;
            this._moveToTop(existing);
        } else {
            this.history.unshift({id: newId(), type: 'text', text, pinned: false, time: Date.now()});
            this._trim();
        }
        this._historyChanged();
    }

    /** @param {GLib.Bytes} bytes PNG */
    addImage(bytes) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const existing = this.history.find(it => it.type === 'image' && it.hash === hash);
        if (existing) {
            if (this.history[0] === existing)
                return;
            this._moveToTop(existing);
        } else {
            const name = `${hash}.png`;
            const file = Gio.File.new_for_path(this.imagePath(name));
            if (!file.query_exists(null))
                writeFileAsync(file, bytes);
            this.history.unshift({id: newId(), type: 'image', image: name, hash, pinned: false, time: Date.now()});
            this._trim();
        }
        this._historyChanged();
    }

    loadImage(item) {
        const [, contents] = Gio.File.new_for_path(this.imagePath(item.image)).load_contents(null);
        return new GLib.Bytes(contents);
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        let unpinned = 0;
        const removed = [];
        this.history = this.history.filter(it => {
            if (it.pinned)
                return true;
            if (++unpinned <= max)
                return true;
            removed.push(it);
            return false;
        });
        removed.forEach(it => this._deleteImageIfUnused(it));
    }

    trim() {
        this._trim();
        this._historyChanged();
    }

    _deleteImageIfUnused(item) {
        if (item.type !== 'image')
            return;
        if (this.history.some(it => it.image === item.image))
            return;
        try {
            Gio.File.new_for_path(this.imagePath(item.image)).delete(null);
        } catch (_e) {}
    }

    removeHistory(id) {
        const item = this.history.find(it => it.id === id);
        if (!item)
            return;
        this.history = this.history.filter(it => it !== item);
        this._deleteImageIfUnused(item);
        this._historyChanged();
    }

    togglePin(id) {
        const item = this.history.find(it => it.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        this._historyChanged();
    }

    clearHistory() {
        const removed = this.history.filter(it => !it.pinned);
        this.history = this.history.filter(it => it.pinned);
        removed.forEach(it => this._deleteImageIfUnused(it));
        this._historyChanged();
    }

    // ------------------------------------------------------------------ notes

    /** Creates or updates a note/account and returns the stored object. */
    saveNote(data) {
        let note = data.id ? this.notes.find(n => n.id === data.id) : null;
        if (!note) {
            note = {id: newId(), pinned: false};
            this.notes.unshift(note);
        }
        note.kind = data.kind === 'account' ? 'account' : 'note';
        note.title = data.title ?? '';
        note.content = data.content ?? '';
        note.username = note.kind === 'account' ? data.username ?? '' : '';
        note.url = note.kind === 'account' ? data.url ?? '' : '';
        note.time = Date.now();
        // Only present when no keyring is available (see secrets.js).
        if ('insecurePassword' in data)
            note.insecurePassword = data.insecurePassword;
        this._notesChanged();
        return note;
    }

    removeNote(id) {
        this.notes = this.notes.filter(n => n.id !== id);
        this._notesChanged();
    }

    toggleNotePin(id) {
        const note = this.notes.find(n => n.id === id);
        if (!note)
            return;
        note.pinned = !note.pinned;
        this._notesChanged();
    }
}
