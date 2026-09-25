// SPDX-License-Identifier: GPL-3.0-or-later
//
// Password generator. Kept free of Shell imports so prefs.js can use it too.

import Gio from 'gi://Gio';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
// Characters that are easy to confuse when read or typed by hand.
const AMBIGUOUS = new Set('0O1lI|`\'"');

export const DEFAULT_SYMBOLS = '!@#$%&*-_=+?';

/** Reads the generator options from the extension settings. */
export function optionsFromSettings(settings) {
    return {
        length: settings.get_int('password-length'),
        uppercase: settings.get_boolean('password-uppercase'),
        lowercase: settings.get_boolean('password-lowercase'),
        digits: settings.get_boolean('password-digits'),
        symbols: settings.get_boolean('password-symbols'),
        symbolSet: settings.get_string('password-symbol-set'),
        excludeAmbiguous: settings.get_boolean('password-exclude-ambiguous'),
    };
}

function randomBytes(n) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return stream.read_bytes(n, null).toArray();
    } finally {
        stream.close(null);
    }
}

/**
 * Returns a function producing uniform random integers in [0, max) from
 * /dev/urandom, without modulo bias. Bytes are read in batches.
 */
function randomSource() {
    let pool = [];
    const nextByte = () => {
        if (!pool.length)
            pool = Array.from(randomBytes(256));
        return pool.pop();
    };
    return max => {
        const limit = 65536 - (65536 % max);
        for (;;) {
            const value = (nextByte() << 8) | nextByte();
            if (value < limit)
                return value % max;
        }
    };
}

/**
 * The character groups enabled by the options. Falls back to lowercase
 * letters when everything is disabled, so a password can always be built.
 */
export function characterGroups(options) {
    const clean = chars => {
        const unique = [...new Set(chars)];
        return (options.excludeAmbiguous ? unique.filter(c => !AMBIGUOUS.has(c)) : unique).join('');
    };
    const groups = [];
    if (options.uppercase)
        groups.push(clean(UPPER));
    if (options.lowercase)
        groups.push(clean(LOWER));
    if (options.digits)
        groups.push(clean(DIGITS));
    if (options.symbols)
        groups.push(clean(options.symbolSet || DEFAULT_SYMBOLS));
    const nonEmpty = groups.filter(g => g.length > 0);
    return nonEmpty.length ? nonEmpty : [clean(LOWER)];
}

/**
 * Generates a password with a cryptographic random source. Every enabled
 * character type appears at least once (when the length allows it).
 */
export function generatePassword(options) {
    const groups = characterGroups(options);
    const alphabet = [...new Set(groups.join(''))];
    const length = Math.max(options.length, 1);
    const mustContainAll = length >= groups.length;
    const randomBelow = randomSource();

    for (;;) {
        let password = '';
        for (let i = 0; i < length; i++)
            password += alphabet[randomBelow(alphabet.length)];
        // Rejection keeps the distribution uniform over valid passwords.
        if (!mustContainAll || groups.every(g => [...password].some(c => g.includes(c))))
            return password;
    }
}

/** Approximate strength in bits of entropy, used for the preferences preview. */
export function entropyBits(options) {
    const alphabet = new Set(characterGroups(options).join(''));
    return Math.floor(Math.max(options.length, 1) * Math.log2(alphabet.size));
}
