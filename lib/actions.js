// SPDX-License-Identifier: GPL-3.0-or-later
// Como executar as ações dos menus. Em ordem de preferência:
//
//   1. GAction do próprio app (org.gtk.Actions) — o app faz exatamente o que
//      o item promete (ex.: app.preferences abre as preferências dele);
//   2. API do Mutter (minimizar, maximizar, tela cheia, fechar…) — funciona
//      com QUALQUER janela, Wayland ou XWayland;
//   3. Atalho de teclado sintetizado (ex.: Ctrl+C) por um teclado virtual do
//      Clutter — último recurso: funciona na grande maioria dos apps, mas não
//      dá para garantir (cada app escolhe seus atalhos).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {debug, logError} from './util.js';

// ---------------------------------------------------------------------------
// Aplicativos e painéis das Configurações
// ---------------------------------------------------------------------------

/**
 * @param {string} desktopId - ex.: 'org.gnome.Settings.desktop'
 * @returns {Shell.App|null}
 */
export function lookupApp(desktopId) {
    return Shell.AppSystem.get_default().lookup_app(desktopId);
}

/**
 * Abre (ou traz para frente) um aplicativo.
 *
 * @param {string} desktopId
 * @returns {boolean} false se o app não está instalado
 */
export function launchApp(desktopId) {
    const app = lookupApp(desktopId);
    if (!app)
        return false;
    app.activate();
    Main.overview.hide();
    return true;
}

/**
 * Abre um painel específico das Configurações. É o mesmo mecanismo que o
 * GNOME Shell usa (ui/status/network.js): a ação "launch-panel" do app.
 *
 * @param {string} panel - ex.: 'system'
 * @param {...string} args - ex.: 'about'
 */
export function openSettingsPanel(panel, ...args) {
    const app = lookupApp('org.gnome.Settings.desktop');
    if (!app)
        return;
    const param = new GLib.Variant('av', [
        new GLib.Variant('(sav)', [panel, args.map(s => new GLib.Variant('s', s))]),
    ]);
    app.activate_action('launch-panel', param, 0, -1, null)
        .catch(e => logError(e, `abrindo Configurações › ${panel}`));
    Main.overview.hide();
}

/**
 * Abre a página do app na Central de Programas (GNOME Software), como o
 * item "Detalhes do aplicativo" do GNOME.
 *
 * @param {Shell.App} app
 * @returns {boolean} false se o GNOME Software não estiver instalado
 */
export function showAppDetails(app) {
    if (!lookupApp('org.gnome.Software.desktop'))
        return false;
    Gio.DBus.session.call(
        'org.gnome.Software', '/org/gnome/Software', 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['details',
            [GLib.Variant.new('(ss)', [app.get_id(), ''])], {}]),
        null, Gio.DBusCallFlags.NONE, -1, null)
        .catch(e => logError(e, 'abrindo detalhes do app'));
    Main.overview.hide();
    return true;
}

// ---------------------------------------------------------------------------
// Teclado virtual (último recurso)
// ---------------------------------------------------------------------------

/**
 * Sintetiza atalhos de teclado. Um único dispositivo virtual por instância,
 * destruído junto com a extensão.
 */
export class VirtualKeyboard {
    constructor() {
        this._device = null;
        this._timeoutId = 0;
    }

    _getDevice() {
        this._device ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        return this._device;
    }

    /**
     * Envia um atalho no formato GTK (ex.: "<Control><Shift>z").
     *
     * Esperamos ~80 ms antes de enviar: o menu acabou de fechar e o foco de
     * teclado precisa voltar para a janela do app.
     *
     * @param {string} accel
     */
    send(accel) {
        const keyvals = acceleratorToKeyvals(accel);
        if (!keyvals.length) {
            debug(`atalho inválido: ${accel}`);
            return;
        }
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._timeoutId = 0;
            const device = this._getDevice();
            // O tempo é em microssegundos (Clutter ≥ 40).
            let time = GLib.get_monotonic_time();
            for (const keyval of keyvals)
                device.notify_keyval(time++, keyval, Clutter.KeyState.PRESSED);
            for (const keyval of [...keyvals].reverse())
                device.notify_keyval(time++, keyval, Clutter.KeyState.RELEASED);
            debug(`atalho sintetizado: ${accel}`);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        // Soltar a referência basta: o GObject é liberado e o dispositivo some.
        this._device = null;
    }
}

const MODIFIER_KEYVALS = {
    control: Clutter.KEY_Control_L,
    ctrl: Clutter.KEY_Control_L,
    primary: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L,
    alt: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L,
};

/**
 * "<Control><Shift>z" → [Control_L, Shift_L, z]
 *
 * @param {string} accel
 * @returns {number[]}
 */
export function acceleratorToKeyvals(accel) {
    const keyvals = [];
    const key = accel.replace(/<([^>]+)>/g, (_m, mod) => {
        const keyval = MODIFIER_KEYVALS[mod.toLowerCase()];
        if (keyval)
            keyvals.push(keyval);
        return '';
    }).trim();
    const keyval = Clutter[`KEY_${key}`];
    if (keyval === undefined)
        return [];
    keyvals.push(keyval);
    return keyvals;
}

// ---------------------------------------------------------------------------
// Janelas (API do Mutter)
// ---------------------------------------------------------------------------

/** @returns {number} tempo do evento atual, exigido por várias APIs do Mutter */
export function now() {
    return global.get_current_time();
}

/**
 * Janelas "normais" de um app, na ordem de empilhamento (a de cima primeiro).
 *
 * @param {Shell.App} app
 * @returns {Meta.Window[]}
 */
export function getAppWindows(app) {
    return app?.get_windows().filter(w => !w.skip_taskbar &&
        w.get_window_type() !== Meta.WindowType.DESKTOP) ?? [];
}
