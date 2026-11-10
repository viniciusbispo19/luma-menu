// SPDX-License-Identifier: GPL-3.0-or-later
// Camada C: as GActions que o app exporta pelo D-Bus (org.gtk.Actions).
//
// Apps GTK que usam GtkApplication publicam ações como "app.about",
// "app.preferences", "app.quit", "app.new-window". Chamar essas ações faz o
// app executar EXATAMENTE o que o item promete — é a forma mais confiável.
//
// Não precisamos falar D-Bus na mão: o próprio GNOME Shell já acompanha
// essas ações. `Shell.App.get_action_group()` devolve um grupo com as ações
// "app.*" (e "win.*" da janela em foco, quando o app as exporta).
//
// Limite importante (verificado no GNOME 51): apps GTK4/libadwaita costumam
// registrar ações de janela como "widget actions", que NÃO são exportadas
// pelo D-Bus. Por isso "win.close", "win.fullscreen" etc. raramente existem —
// para esses usamos a API do Mutter ou o teclado virtual (actions.js).

import {debug, logError} from '../util.js';

/** Nomes alternativos das ações mais comuns (apps diferentes, nomes diferentes). */
export const KNOWN_ACTIONS = {
    about: ['app.about'],
    preferences: ['app.preferences', 'app.settings', 'app.prefs', 'win.preferences',
        'app.show-preferences', 'win.show-preferences', 'app.show-settings'],
    quit: ['app.quit'],
    newWindow: ['app.new-window', 'win.new-window', 'app.new_window'],
    newTab: ['win.new-tab', 'app.new-tab', 'win.tab-new'],
    open: ['win.open', 'app.open', 'win.open-file'],
    save: ['win.save', 'app.save'],
    saveAs: ['win.save-as', 'app.save-as'],
    print: ['win.print', 'app.print'],
    closeWindow: ['win.close', 'win.close-window'],
    undo: ['win.undo', 'app.undo'],
    redo: ['win.redo', 'app.redo'],
    find: ['win.find', 'win.search', 'app.find', 'win.show-search'],
    help: ['app.help', 'win.help', 'app.show-help'],
    shortcuts: ['win.show-help-overlay', 'app.shortcuts', 'app.show-shortcuts',
        'win.show-shortcuts', 'app.keyboard-shortcuts'],
    fullscreen: ['win.fullscreen', 'win.toggle-fullscreen', 'app.fullscreen'],
    zoomIn: ['win.zoom-in', 'app.zoom-in'],
    zoomOut: ['win.zoom-out', 'app.zoom-out'],
    zoomReset: ['win.zoom-reset', 'win.zoom-normal', 'app.zoom-reset', 'win.zoom-one'],
    sidebar: ['win.toggle-sidebar', 'win.show-sidebar', 'win.sidebar'],
};

export class AppActions {
    /**
     * @param {Shell.App|null} app
     */
    constructor(app) {
        this._group = app?.get_action_group() ?? null;
        // Primeira leitura: faz o Shell buscar as ações, se ainda não buscou.
        this._group?.list_actions();
    }

    /** @returns {Gio.ActionGroup|null} */
    get group() {
        return this._group;
    }

    /** @returns {string[]} todas as ações ("app.about", …) */
    list() {
        return this._group?.list_actions() ?? [];
    }

    /**
     * Uma ação existe e pode ser chamada SEM parâmetro?
     *
     * @param {string} name
     * @returns {boolean}
     */
    has(name) {
        if (!this._group?.has_action(name))
            return false;
        // Ações que exigem parâmetro (ex.: "app.open-file(s)") não servem
        // para um item de menu simples.
        return this._group.get_action_parameter_type(name) === null;
    }

    /**
     * Primeira ação existente entre os nomes alternativos.
     *
     * @param {string} key - chave de KNOWN_ACTIONS ou um nome de ação
     * @returns {string|null}
     */
    find(key) {
        const names = KNOWN_ACTIONS[key] ?? [key];
        return names.find(n => this.has(n)) ?? null;
    }

    /** @param {string} name */
    isEnabled(name) {
        return this._group?.get_action_enabled(name) ?? false;
    }

    /**
     * Estado de uma ação marcável (ex.: "win.fullscreen" = true/false).
     *
     * @param {string} name
     * @returns {any}
     */
    getState(name) {
        try {
            return this._group?.get_action_state(name)?.recursiveUnpack() ?? null;
        } catch {
            return null;
        }
    }

    /**
     * @param {string} name
     * @param {GLib.Variant|null} [parameter]
     */
    activate(name, parameter = null) {
        try {
            this._group?.activate_action(name, parameter);
            debug(`GAction: ${name}`);
        } catch (e) {
            logError(e, `ativando ${name}`);
        }
    }

    /**
     * Cria um nó de menu ligado a uma ação conhecida, ou null se o app não a tem.
     *
     * @param {string} key - chave de KNOWN_ACTIONS
     * @param {object} node - {label, accel, …}
     * @returns {object|null}
     */
    node(key, node) {
        const name = this.find(key);
        if (!name)
            return null;
        const state = this.getState(name);
        return {
            ...node,
            sensitive: this.isEnabled(name),
            checked: typeof state === 'boolean' ? state : node.checked ?? null,
            activate: () => this.activate(name),
        };
    }
}
