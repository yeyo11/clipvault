// SPDX-License-Identifier: GPL-3.0-or-later
//
// Account passwords are stored in the GNOME Keyring through libsecret.
// If libsecret is unavailable they fall back to notes.json as a last resort.
//
// Nothing is created at import time: init() is called from enable() and
// uninit() from disable(), as the extension review guidelines require.

let Secret = null;
let schema = null;
let ready = Promise.resolve();

async function load() {
    try {
        ({default: Secret} = await import('gi://Secret'));
        schema = new Secret.Schema('org.gnome.shell.extensions.clipvault.Account',
            Secret.SchemaFlags.NONE, {id: Secret.SchemaAttributeType.STRING});
    } catch (e) {
        Secret = null;
        schema = null;
        console.warn(`[clipvault] libsecret is unavailable, passwords will be stored unencrypted: ${e.message}`);
    }
}

export function init() {
    ready = load();
    return ready;
}

export function uninit() {
    schema = null;
    Secret = null;
    ready = Promise.resolve();
}

/** Whether passwords go to the keyring (true) or to notes.json (false). */
export function isAvailable() {
    return schema !== null;
}

export async function lookupPassword(note) {
    await ready;
    if (!schema)
        return note.insecurePassword ?? '';
    return new Promise((resolve, reject) => {
        Secret.password_lookup(schema, {id: note.id}, null, (_s, res) => {
            try {
                resolve(Secret.password_lookup_finish(res) ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Stores the password. Without a keyring it is written into the note object. */
export async function storePassword(note, password) {
    await ready;
    if (!schema) {
        note.insecurePassword = password;
        return;
    }
    if (!password) {
        await clearPassword(note);
        return;
    }
    const label = `ClipVault: ${note.title || note.username || note.id}`;
    await new Promise((resolve, reject) => {
        Secret.password_store(schema, {id: note.id}, Secret.COLLECTION_DEFAULT,
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

export async function clearPassword(note) {
    await ready;
    if (!schema) {
        delete note.insecurePassword;
        return;
    }
    await new Promise(resolve => {
        Secret.password_clear(schema, {id: note.id}, null, (_s, res) => {
            try {
                Secret.password_clear_finish(res);
            } catch (_e) {}
            resolve();
        });
    });
}
