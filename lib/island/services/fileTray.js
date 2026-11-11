// SPDX-License-Identifier: GPL-3.0-or-later
// Abre a bandeja de arquivos (tray/tray.js, uma janelinha GTK 4) e a coloca
// no canto direito, embaixo do relógio, sempre por cima e em todas as áreas de
// trabalho — como a "prateleira" do Isle.
//
// Por que a bandeja é uma janela e não parte do pop-up do relógio? Ver o
// comentário no começo de tray/tray.js: no Wayland, o Shell não recebe nem
// entrega arquivos arrastados; só um app consegue.
//
// O processo só existe enquanto a janela está aberta. Ao desativar a
// extensão, a bandeja é fechada junto.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {debug, logError} from '../../util.js';

const APP_ID = 'io.github.viniciusbispo19.LumaMenu.Tray';
/** Distância da borda direita e da barra: a mesma dos pop-ups (px). */
const MARGIN_RIGHT = 12;
const MARGIN_TOP = 8;

export class FileTray {
    /** @param {string} extensionPath - pasta da extensão instalada */
    constructor(extensionPath) {
        this._script = GLib.build_filenamev([extensionPath, 'tray', 'tray.js']);
        this._localeDir = GLib.build_filenamev([extensionPath, 'locale']);
        this._process = null;
        global.display.connectObject('window-created', (_d, window) => this._onWindowCreated(window), this);
    }

    /** @returns {Meta.Window|null} a janela da bandeja, se aberta */
    get window() {
        return global.get_window_actors().map(a => a.meta_window)
            .find(w => isTrayWindow(w)) ?? null;
    }

    /** Abre a bandeja (ou a traz para a frente, se já está aberta). */
    open() {
        const window = this.window;
        if (window) {
            // Já aberta: só mostrar. Sem tirar o foco do app (você pode estar
            // no meio de um arraste a partir dele).
            if (window.minimized)
                window.unminimize();
            window.raise();
            return;
        }
        if (this._process)
            return; // abrindo
        try {
            const proc = Gio.Subprocess.new(['gjs', '-m', this._script, this._localeDir],
                Gio.SubprocessFlags.NONE);
            this._process = proc;
            proc.wait_async(null, () => {
                if (this._process === proc)
                    this._process = null;
            });
            debug('bandeja: aberta');
        } catch (e) {
            logError(e, 'abrindo a bandeja de arquivos');
        }
    }

    _onWindowCreated(window) {
        // Só olhamos janelas novas enquanto a bandeja está abrindo.
        if (!this._process)
            return;
        // Duas esperas:
        //   - no Wayland, a janela nasce SEM o ID do app (app_id): ele chega
        //     logo depois, então ainda não dá para saber se é a bandeja;
        //   - posicionar cedo demais não adianta: o Mutter (e extensões de
        //     "tiling", como o gnome-mosaic) colocam a janela nova no lugar
        //     delas.
        // Por isso esperamos o PRIMEIRO QUADRO desenhado (o mesmo momento em
        // que o Shell anima janelas novas). O ator da janela só existe depois
        // do "window-created" — daí o "later".
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            const actor = window.get_compositor_private();
            if (!actor)
                return GLib.SOURCE_REMOVE;
            actor.connectObject('first-frame', () => {
                actor.disconnectObject(this);
                if (isTrayWindow(window))
                    this._place(window);
            }, this);
            return GLib.SOURCE_REMOVE;
        });
    }

    _place(window) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const frame = window.get_frame_rect();
        const x = monitor.x + monitor.width - frame.width - MARGIN_RIGHT;
        const y = monitor.y + Main.panel.height + MARGIN_TOP;
        window.move_frame(true, x, y);
        window.make_above();
        window.stick();
    }

    destroy() {
        global.display.disconnectObject(this);
        // A bandeja é parte da extensão: some junto. (A lista fica salva.)
        // Fora de um evento, get_current_time() vale 0 e o Mutter reclama
        // ("bad serial"): o "roundtrip" pega a hora certa do servidor.
        this.window?.delete(global.display.get_current_time_roundtrip());
        this._process?.send_signal(15); // SIGTERM, caso a janela ainda não exista
        this._process = null;
    }
}

function isTrayWindow(window) {
    return window?.get_wm_class() === APP_ID || window?.get_gtk_application_id() === APP_ID;
}
