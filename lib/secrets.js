// SPDX-License-Identifier: GPL-3.0-or-later
//
// Account passwords are stored in the GNOME Keyring through libsecret.
// If libsecret is unavailable they fall back to notes.json as a last resort.

import Gio from 'gi://Gio';

let Secret = null;
try {
    ({default: Secret} = await import('gi://Secret'));
} catch (e) {
    console.warn(`[clipvault] libsecret is unavailable, passwords will be stored unencrypted: ${e.message}`);
}

const SCHEMA = Secret
    ? new Secret.Schema('org.gnome.shell.extensions.clipvault.Account',
        Secret.SchemaFlags.NONE, {id: Secret.SchemaAttributeType.STRING})
    : null;

export const available = SCHEMA !== null;

export function lookupPassword(note) {
    if (!SCHEMA)
        return Promise.resolve(note.insecurePassword ?? '');
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, {id: note.id}, null, (_s, res) => {
            try {
                resolve(Secret.password_lookup_finish(res) ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Stores the password. Without a keyring it is written into the note object. */
export function storePassword(note, password) {
    if (!SCHEMA) {
        note.insecurePassword = password;
        return Promise.resolve();
    }
    if (!password)
        return clearPassword(note);
    const label = `ClipVault: ${note.title || note.username || note.id}`;
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, {id: note.id}, Secret.COLLECTION_DEFAULT,
            label, password, null, (_s, res) => {
                try {
                    Secret.password_store_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function clearPassword(note) {
    if (!SCHEMA) {
        delete note.insecurePassword;
        return Promise.resolve();
    }
    return new Promise(resolve => {
        Secret.password_clear(SCHEMA, {id: note.id}, null, (_s, res) => {
            try {
                Secret.password_clear_finish(res);
            } catch (_e) {}
            resolve();
        });
    });
}

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_=+?';

function randomBytes(n) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return stream.read_bytes(n, null).toArray();
    } finally {
        stream.close(null);
    }
}

/** Random password from a cryptographic source (/dev/urandom). */
export function generatePassword(length = 20) {
    // Rejection sampling so the first characters of the set are not favoured.
    const limit = 256 - (256 % CHARSET.length);
    let out = '';
    while (out.length < length) {
        for (const b of randomBytes(length * 2)) {
            if (b < limit && out.length < length)
                out += CHARSET[b % CHARSET.length];
        }
    }
    return out;
}
