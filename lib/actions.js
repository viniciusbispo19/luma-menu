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
        // GNOME 51: Clutter.get_default_backend() não existe mais; o backend
        // vem do contexto do palco (é como o próprio Shell faz em screenShield.js).
        this._device ??= global.stage.context.get_backend().get_default_seat()
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

/** @returns {Meta.Workspace} a área de trabalho atual */
function activeWorkspace() {
    return global.workspace_manager.get_active_workspace();
}

/**
 * Janelas normais da área de trabalho atual (de todos os apps).
 *
 * @returns {Meta.Window[]}
 */
export function getWorkspaceWindows() {
    return activeWorkspace().list_windows().filter(w => !w.skip_taskbar &&
        w.get_window_type() === Meta.WindowType.NORMAL);
}

/**
 * "Ocultar <App>": minimiza todas as janelas do app (o GNOME não tem o
 * conceito de "ocultar" do macOS; minimizar é o equivalente mais próximo).
 *
 * @param {Shell.App} app
 */
export function hideApp(app) {
    for (const window of getAppWindows(app)) {
        if (window.can_minimize())
            window.minimize();
    }
}

/**
 * "Ocultar Outros": minimiza as janelas dos outros apps nesta área de trabalho.
 *
 * @param {Shell.App} app - o app que fica visível
 */
export function hideOthers(app) {
    const tracker = Shell.WindowTracker.get_default();
    for (const window of getWorkspaceWindows()) {
        if (tracker.get_window_app(window) !== app && window.can_minimize())
            window.minimize();
    }
}

/** @param {Shell.App} app */
export function canHideOthers(app) {
    const tracker = Shell.WindowTracker.get_default();
    return getWorkspaceWindows().some(w => !w.minimized &&
        tracker.get_window_app(w) !== app);
}

/** "Mostrar Tudo": restaura as janelas minimizadas desta área de trabalho. */
export function showAll() {
    for (const window of getWorkspaceWindows()) {
        if (window.minimized)
            window.unminimize();
    }
}

/** @returns {boolean} há alguma janela minimizada para mostrar? */
export function canShowAll() {
    return getWorkspaceWindows().some(w => w.minimized);
}

// ---------------------------------------------------------------------------
// Menu Janela / Visualizar (API do Mutter — funciona com qualquer janela)
// ---------------------------------------------------------------------------

/** @param {Meta.Window} window */
export function toggleMaximize(window) {
    if (window.is_maximized())
        window.unmaximize();
    else if (window.can_maximize())
        window.maximize(); // Mutter 51: sem parâmetros (antes era maximize(flags))
}

/** @param {Meta.Window} window */
export function toggleFullscreen(window) {
    if (window.is_fullscreen())
        window.unmake_fullscreen();
    else
        window.make_fullscreen();
}

/** @param {Meta.Window} window */
export function toggleAbove(window) {
    if (window.is_above())
        window.unmake_above();
    else
        window.make_above();
}

/**
 * "Mover para a Metade Esquerda/Direita da Tela".
 *
 * O Mutter 51 não tem API pública de "lado a lado" (Meta.TileMode não existe
 * no GJS). Então sintetizamos o atalho REAL do usuário para isso
 * (org.gnome.mutter.keybindings toggle-tiled-left/right) — assim quem encaixa
 * é o próprio Mutter (ou a extensão de tiling que tomou conta do atalho).
 * Sem atalho configurado, redimensionamos a janela para meia área útil.
 *
 * @param {Meta.Window} window
 * @param {'left'|'right'} side
 * @param {VirtualKeyboard} keyboard
 */
export function moveToHalf(window, side, keyboard) {
    const mutterKeys = new Gio.Settings({schema_id: 'org.gnome.mutter.keybindings'});
    const accel = mutterKeys.get_strv(`toggle-tiled-${side}`)[0];
    if (accel) {
        keyboard.send(accel);
        return;
    }
    const area = Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
    const width = Math.floor(area.width / 2);
    if (window.is_maximized())
        window.unmaximize();
    window.move_resize_frame(true, side === 'left' ? area.x : area.x + width,
        area.y, width, area.height);
}

/** @param {Meta.Window} window */
export function moveToNextMonitor(window) {
    const n = global.display.get_n_monitors();
    if (n > 1)
        window.move_to_monitor((window.get_monitor() + 1) % n);
}

/**
 * @param {Meta.Window} window
 * @param {number} index
 */
export function moveToWorkspace(window, index) {
    window.change_workspace_by_index(index, false);
}

/**
 * "Trazer Tudo para a Frente": todas as janelas do app sobem, e a janela em
 * foco continua por cima.
 *
 * @param {Shell.App} app
 * @param {Meta.Window|null} focused
 */
export function bringAllToFront(app, focused) {
    const windows = global.display.sort_windows_by_stacking(getAppWindows(app));
    for (const window of windows) {
        if (window.minimized)
            window.unminimize();
        window.raise();
    }
    if (focused)
        Main.activateWindow(focused);
}

/**
 * Fecha a janela educadamente (como clicar no X): o app pode perguntar se
 * você quer salvar.
 *
 * @param {Meta.Window} window
 */
export function closeWindow(window) {
    window.delete(now());
}

/** @param {Shell.App} app */
export function closeAllWindows(app) {
    for (const window of getAppWindows(app))
        window.delete(now());
}
