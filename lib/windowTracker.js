// SPDX-License-Identifier: GPL-3.0-or-later
// Descobre qual janela e qual aplicativo estão em foco e avisa (sinal
// "changed") quando isso muda. É o que faz a barra "seguir" o app ativo.
//
// Fontes:
//  - global.display "notify::focus-window": muda a cada troca de janela,
//    inclusive ao trocar de área de trabalho ou de monitor;
//  - Shell.WindowTracker "notify::focus-app": o Shell associa cada janela ao
//    seu .desktop (é assim que sabemos o NOME do app, "Editor de Texto").
//
// Sem janela em foco (área de trabalho vazia), mostramos o app Arquivos
// (Nautilus) — como o Finder no macOS.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {debug} from './util.js';

export const DESKTOP_APP_ID = 'org.gnome.Nautilus.desktop';

export class FocusTracker extends Signals.EventEmitter {
    constructor() {
        super();
        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
        this._window = null;
        this._app = null;
        this._isDesktop = false;

        global.display.connectObject('notify::focus-window', () => this._update(), this);
        this._tracker.connectObject('notify::focus-app', () => this._update(), this);
        this._update();
    }

    /** @returns {Meta.Window|null} janela em foco (null = área de trabalho) */
    get window() {
        return this._window;
    }

    /** @returns {Shell.App|null} app em foco (Arquivos quando na área de trabalho) */
    get app() {
        return this._app;
    }

    /** @returns {boolean} true quando nenhuma janela está em foco */
    get isDesktop() {
        return this._isDesktop;
    }

    _update() {
        let window = global.display.focus_window;
        // Ícones da área de trabalho (ex.: extensão DING) contam como "mesa".
        if (window?.get_window_type() === Meta.WindowType.DESKTOP)
            window = null;

        let app = window ? this._tracker.get_window_app(window) : null;
        const isDesktop = window === null;
        if (isDesktop)
            app = this._appSystem.lookup_app(DESKTOP_APP_ID);

        if (window === this._window && app === this._app)
            return;

        this._window = window;
        this._app = app;
        this._isDesktop = isDesktop;

        // Pede ao Shell para incluir as ações "win.*" desta janela no grupo
        // de ações do app (apps GTK que exportam ações de janela).
        if (window && app)
            app.update_window_actions(window);

        debug(`foco: ${app?.get_id() ?? '(nenhum app)'} — ${window?.get_title() ?? 'área de trabalho'}`);
        this.emit('changed');
    }

    destroy() {
        global.display.disconnectObject(this);
        this._tracker.disconnectObject(this);
        this._window = null;
        this._app = null;
    }
}
