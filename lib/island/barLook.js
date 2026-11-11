// SPDX-License-Identifier: GPL-3.0-or-later
// "A cor da barra", num lugar só.
//
// As formas que saem da barra (o painel do relógio e os menus) precisam ter
// a MESMA cor que ela, para as duas parecerem uma peça só:
//   - barra preta ligada: preto fumê na opacidade escolhida (o desfoque do
//     Blur my Shell aparece de leve por trás);
//   - barra preta desligada: a cor que o tema (ou o Blur my Shell) dá à barra.
//
// Quem usa escuta o sinal "changed" para se atualizar ao vivo.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export class BarLook extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._tint = [0, 0, 0, 0.85];
        settings.connectObject(
            'changed::black-bar', () => this._update(),
            'changed::black-bar-opacity', () => this._update(),
            this);
        // O tema, o Blur my Shell ou a nossa barra preta mudaram o painel.
        Main.panel.connectObject('style-changed', () => this._update(), this);
        this._update();
    }

    /** @returns {number[]} [r, g, b (0–255), alfa (0–1)] */
    get tint() {
        return this._tint;
    }

    /** Os menus da barra também usam o visual do Isle? */
    get menusEnabled() {
        return this._settings.get_boolean('island-menus');
    }

    _update() {
        let tint;
        if (this._settings.get_boolean('black-bar')) {
            tint = [0, 0, 0, this._settings.get_int('black-bar-opacity') / 100];
        } else {
            const c = Main.panel.get_theme_node().get_background_color();
            tint = [c.red, c.green, c.blue, c.alpha / 255];
        }
        if (tint.every((v, i) => Math.abs(v - this._tint[i]) < 0.001))
            return;
        this._tint = tint;
        this.emit('changed');
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.panel.disconnectObject(this);
    }
}
