// SPDX-License-Identifier: GPL-3.0-or-later
//
// Persistence for the clipboard history and for notes/accounts.
//
// Everything lives in ~/.local/share/clipvault/ with 0700/0600 permissions:
//   history.json  -> history items (text, or a reference to an image)
//   notes.json    -> notes and accounts (passwords are NOT here, see secrets.js)
//   images/       -> copied images as PNG, named after their SHA-256
//
// All file IO is asynchronous so the Shell never blocks on the disk.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const SAVE_DELAY_MS = 800;
const MAX_TEXT_LENGTH = 512 * 1024;

function newId() {
    return GLib.uuid_string_random();
}

function isNotFound(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// ---------------------------------------------------------- async helpers

function loadContents(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                resolve(contents);
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readJson(file, fallback, cancellable) {
    try {
        return JSON.parse(new TextDecoder().decode(await loadContents(file, cancellable)));
    } catch (e) {
        if (isCancelled(e))
            throw e;
        if (!isNotFound(e))
            console.warn(`[clipvault] Could not read ${file.get_path()}: ${e.message}`);
        return fallback;
    }
}

function writeFile(file, bytes) {
    return new Promise(resolve => {
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
                resolve();
            });
    });
}

function deleteFile(file) {
    file.delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
        try {
            f.delete_finish(res);
        } catch (e) {
            if (!isNotFound(e))
                console.warn(`[clipvault] Could not delete ${f.get_path()}: ${e.message}`);
        }
    });
}

/** Names of the files in a directory (empty if it doesn't exist). */
function listNames(dir, cancellable) {
    return new Promise((resolve, reject) => {
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable, (d, res) => {
                let enumerator;
                try {
                    enumerator = d.enumerate_children_finish(res);
                } catch (e) {
                    if (isNotFound(e))
                        resolve([]);
                    else
                        reject(e);
                    return;
                }
                const names = [];
                const next = () => {
                    enumerator.next_files_async(100, GLib.PRIORITY_LOW, cancellable, (en, r) => {
                        let infos;
                        try {
                            infos = en.next_files_finish(r);
                        } catch (e) {
                            enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                            reject(e);
                            return;
                        }
                        if (infos.length === 0) {
                            enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                            resolve(names);
                            return;
                        }
                        infos.forEach(info => names.push(info.get_name()));
                        next();
                    });
                };
                next();
            });
    });
}

// ------------------------------------------------------------------ store

export class Store extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;

        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'clipvault']);
        this._imageDir = GLib.build_filenamev([this._dir, 'images']);
        // A single tiny mkdir; also sets the private 0700 mode.
        GLib.mkdir_with_parents(this._imageDir, 0o700);

        this._historyFile = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'history.json']));
        this._notesFile = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'notes.json']));

        this._pending = new Map(); // file -> timeout id
        this._loaded = false;
        this._dirty = new Set(); // files changed before loading finished
        this._cancellable = new Gio.Cancellable();

        /** @type {Array<{id, type: 'text'|'image', text?, image?, hash?, pinned, time}>} */
        this.history = [];
        /** @type {Array<{id, kind: 'note'|'account', title, content, username, url, pinned, time}>} */
        this.notes = [];

        this._load().catch(e => {
            if (!isCancelled(e))
                console.error(`[clipvault] Could not load data: ${e.message}`);
        });
    }

    async _load() {
        const cancellable = this._cancellable;
        const [historyData, notesData, imageNames] = await Promise.all([
            this._settings.get_boolean('save-history')
                ? readJson(this._historyFile, {items: []}, cancellable)
                : {items: []},
            readJson(this._notesFile, {items: []}, cancellable),
            listNames(Gio.File.new_for_path(this._imageDir), cancellable),
        ]);
        if (cancellable.is_cancelled())
            return;

        const images = new Set(imageNames);
        const loadedHistory = (historyData.items ?? []).filter(it =>
            it.type === 'text' ? typeof it.text === 'string' : images.has(it.image));

        // Anything copied while we were loading goes first; skip duplicates.
        const isDuplicate = it => this.history.some(h =>
            (it.type === 'text' && h.text === it.text) || (it.type === 'image' && h.hash === it.hash));
        this.history = [...this.history, ...loadedHistory.filter(it => !isDuplicate(it))];
        const noteIds = new Set(this.notes.map(n => n.id));
        this.notes = [...this.notes, ...(notesData.items ?? []).filter(n => !noteIds.has(n.id))];
        this._trim();

        this._loaded = true;
        this._dirty.forEach(file => this._scheduleSave(file));
        this._dirty.clear();

        // Delete images no longer referenced by the history.
        const used = new Set(this.history.map(it => it.image).filter(Boolean));
        imageNames.filter(name => !used.has(name))
            .forEach(name => deleteFile(Gio.File.new_for_path(this.imagePath(name))));

        this.emit('history-changed');
        this.emit('notes-changed');
    }

    destroy() {
        this._cancellable.cancel();
        // Flush pending writes. They finish in the background after disable().
        for (const [file, id] of this._pending) {
            GLib.source_remove(id);
            writeFile(file, this._serialize(file));
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
        return new GLib.Bytes(new TextEncoder().encode(JSON.stringify(obj)));
    }

    _scheduleSave(file) {
        // Writing before the file was read would overwrite the stored data.
        if (!this._loaded) {
            this._dirty.add(file);
            return;
        }
        if (this._pending.has(file))
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._pending.delete(file);
            writeFile(file, this._serialize(file));
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
            writeFile(Gio.File.new_for_path(this.imagePath(name)), bytes);
            this.history.unshift({id: newId(), type: 'image', image: name, hash, pinned: false, time: Date.now()});
            this._trim();
        }
        this._historyChanged();
    }

    /** @returns {Promise<GLib.Bytes>} the PNG data of an image item */
    async loadImage(item) {
        return new GLib.Bytes(await loadContents(Gio.File.new_for_path(this.imagePath(item.image)), null));
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
        deleteFile(Gio.File.new_for_path(this.imagePath(item.image)));
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
