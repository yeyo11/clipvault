// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keeps track of where the text caret is, so the popup can open right next to
// it like Windows' Win+V does.
//
// Applications report their caret rectangle to the input method (IBus) so it
// can place its candidate window. GNOME Shell is the IBus panel, and its
// IBusManager re-emits that as `set-cursor-location` in screen coordinates.
// Clients that use relative coordinates (e.g. Qt on Wayland) only reach the
// panel service's `set-cursor-location-relative`, so we listen to that as well.

import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';

export class CaretTracker {
    constructor() {
        this._rect = null;
        this._manager = getIBusManager();
        this._managerIds = [
            this._manager.connect('set-cursor-location', (_m, loc) => this._update(loc)),
            this._manager.connect('focus-in', () => this._clear()),
            this._manager.connect('focus-out', () => this._clear()),
        ];
        this._connectRelative();
        // The panel service is (re)created when IBus (re)starts.
        this._managerIds.push(this._manager.connect('ready', () => this._connectRelative()));
    }

    destroy() {
        this._managerIds.forEach(id => this._manager.disconnect(id));
        this._managerIds = [];
        this._disconnectRelative();
        this._rect = null;
    }

    _connectRelative() {
        // Private field, so be defensive: missing on old IBus or future Shells.
        const service = this._manager._panelService;
        if (!service || service === this._panelService)
            return;
        this._disconnectRelative();
        try {
            this._relativeId = service.connect('set-cursor-location-relative', (_ps, x, y, width, height) => {
                const actor = global.display.focus_window?.get_compositor_private();
                if (actor)
                    this._update({x: actor.x + x, y: actor.y + y, width, height});
            });
            this._panelService = service;
        } catch (_e) {
            this._relativeId = 0;
        }
    }

    _disconnectRelative() {
        if (this._panelService && this._relativeId)
            this._panelService.disconnect(this._relativeId);
        this._panelService = null;
        this._relativeId = 0;
    }

    _update({x, y, width, height}) {
        // Text fields inside the Shell itself (our own search entry, the
        // overview search…) report too; only application windows matter.
        const keyFocus = global.stage.get_key_focus();
        if (keyFocus && keyFocus !== global.stage)
            return;
        // IBus resets the location to 0,0,0,0 when an input context goes away.
        if (x <= 0 && y <= 0 && width <= 0 && height <= 0) {
            this._clear();
            return;
        }
        const window = global.display.focus_window;
        this._rect = {
            x, y, width, height,
            window,
            frame: window?.get_frame_rect() ?? null,
        };
    }

    _clear() {
        this._rect = null;
    }

    /**
     * The caret rectangle of the focused text field in stage coordinates,
     * or null if unknown (no text field focused, or the app doesn't report it).
     */
    get rect() {
        const r = this._rect;
        const window = global.display.focus_window;
        if (!r || !window || r.window !== window)
            return null;

        // Follow the window if it moved since the caret was last reported.
        let {x, y} = r;
        if (r.frame) {
            const frame = window.get_frame_rect();
            x += frame.x - r.frame.x;
            y += frame.y - r.frame.y;
        }
        return {x, y, width: r.width, height: Math.max(r.height, 1)};
    }
}
