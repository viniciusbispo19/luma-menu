// SPDX-License-Identifier: GPL-3.0-or-later
// Camada A: a barra de menus que apps GTK exportam pelo D-Bus.
//
// Um app GTK com GtkApplication + gtk_application_set_menubar() publica:
//   - o MENU   em org.gtk.Menus   (estrutura: rótulos, seções, submenus);
//   - as AÇÕES em org.gtk.Actions (o que cada item faz, se está habilitado,
//     se está marcado).
// O Mutter guarda, para cada janela, o nome D-Bus do app e esses caminhos
// (Meta.Window.get_gtk_*). Com eles, o próprio Gio nos dá proxies prontos:
//   Gio.DBusMenuModel  → um GMenuModel "remoto" (lido como um menu local);
//   Gio.DBusActionGroup → um GActionGroup "remoto".
// Tudo é assíncrono: os dados chegam depois e o modelo emite "items-changed".

import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {KNOWN_ACTIONS} from './actionSource.js';
import {debug, logError} from '../util.js';

/**
 * Remove os mnemônicos do GTK: "_Arquivo" → "Arquivo", "__" → "_".
 *
 * @param {string} label
 * @returns {string}
 */
export function cleanMnemonic(label) {
    return (label ?? '').replace(/_(_)?/g, (_m, underscore) => (underscore ? '_' : ''));
}

function unpack(variant) {
    try {
        return variant?.recursiveUnpack() ?? null;
    } catch {
        return null;
    }
}

export class GtkMenuSource extends Signals.EventEmitter {
    /**
     * A janela exporta algum menu GTK?
     *
     * @param {Meta.Window|null} window
     * @returns {boolean}
     */
    static isAvailable(window) {
        return Boolean(window?.get_gtk_unique_bus_name() &&
            (window.get_gtk_menubar_object_path() || window.get_gtk_app_menu_object_path()));
    }

    /** @param {Meta.Window} window */
    constructor(window) {
        super();
        const conn = Gio.DBus.session;
        const bus = window.get_gtk_unique_bus_name();
        const menubarPath = window.get_gtk_menubar_object_path();
        const appMenuPath = window.get_gtk_app_menu_object_path();
        const appPath = window.get_gtk_application_object_path();
        const winPath = window.get_gtk_window_object_path();

        this._menubar = menubarPath ? Gio.DBusMenuModel.get(conn, bus, menubarPath) : null;
        this._appMenu = appMenuPath ? Gio.DBusMenuModel.get(conn, bus, appMenuPath) : null;

        // As ações chegam com prefixo ("app.quit"); cada prefixo é um grupo.
        this._groups = {};
        if (appPath)
            this._groups.app = Gio.DBusActionGroup.get(conn, bus, appPath);
        if (winPath)
            this._groups.win = Gio.DBusActionGroup.get(conn, bus, winPath);
        for (const group of Object.values(this._groups)) {
            group.list_actions(); // começa a buscar as ações
            group.connectObject(
                'action-added', () => this._changed(),
                'action-removed', () => this._changed(),
                'action-enabled-changed', () => this._changed(),
                'action-state-changed', () => this._changed(),
                this);
        }

        // Observa o menu inteiro (todos os submenus): o GDBusMenuModel só
        // busca um submenu quando alguém o lê, e avisa com "items-changed".
        this._watched = new Set();
        this._watch(this._menubar);
        this._watch(this._appMenu);
        debug(`camada A: ${bus} ${menubarPath ?? ''} ${appMenuPath ?? ''}`);
    }

    _watch(model) {
        if (!model || this._watched.has(model))
            return;
        this._watched.add(model);
        model.connectObject('items-changed', () => {
            this._walk(model);
            this._changed();
        }, this);
        this._walk(model);
    }

    /** Lê o modelo (o que dispara a busca) e observa os sub-modelos. */
    _walk(model) {
        const n = model.get_n_items();
        for (let i = 0; i < n; i++) {
            for (const link of [Gio.MENU_LINK_SUBMENU, Gio.MENU_LINK_SECTION]) {
                const sub = model.get_item_link(i, link);
                if (sub)
                    this._watch(sub);
            }
        }
    }

    _changed() {
        this.emit('changed');
    }

    /** @returns {boolean} já chegou alguma barra de menus com itens? */
    get hasMenus() {
        return (this._menubar?.get_n_items() ?? 0) > 0;
    }

    /**
     * Os menus de topo da barra do app ("Arquivo", "Editar"…).
     *
     * @returns {{id: string, title: string, build: Function}[]}
     */
    getMenus() {
        const model = this._menubar;
        if (!model)
            return [];
        const menus = [];
        for (let i = 0; i < model.get_n_items(); i++) {
            const sub = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
            if (!sub)
                continue;
            const title = cleanMnemonic(unpack(model.get_item_attribute_value(i, 'label', null)));
            menus.push({id: `gtk:${i}`, title, build: () => this.buildModel(sub)});
        }
        return menus;
    }

    /**
     * Converte um GMenuModel nos nós de menu do Luma Menu (veja popup.js).
     *
     * @param {Gio.MenuModel} model
     * @returns {object[]}
     */
    buildModel(model) {
        const nodes = [];
        const n = model.get_n_items();
        for (let i = 0; i < n; i++) {
            try {
                const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
                if (section) {
                    // Seção = grupo separado por linhas; pode ter um título.
                    nodes.push({separator: true});
                    const label = unpack(model.get_item_attribute_value(i, 'label', null));
                    if (label)
                        nodes.push({header: cleanMnemonic(label)});
                    nodes.push(...this.buildModel(section));
                    nodes.push({separator: true});
                    continue;
                }
                const node = this._itemNode(model, i);
                if (node)
                    nodes.push(node);
            } catch (e) {
                logError(e, 'lendo item de menu GTK');
            }
        }
        return nodes;
    }

    _itemNode(model, i) {
        const attr = name => model.get_item_attribute_value(i, name, null);
        const label = cleanMnemonic(unpack(attr('label')));
        const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
        const icon = attr('icon') ? Gio.Icon.deserialize(attr('icon')) : null;

        if (submenu)
            return {label, icon, children: () => this.buildModel(submenu)};

        const action = unpack(attr('action'));
        const target = attr('target'); // GLib.Variant ou null
        const accel = unpack(attr('accel')) ?? '';
        const hiddenWhen = unpack(attr('hidden-when'));

        const info = this._actionInfo(action);
        if (hiddenWhen === 'action-missing' && !info.exists)
            return null;
        if (hiddenWhen === 'action-disabled' && !info.enabled)
            return null;

        // Marcado? Ação booleana → o próprio estado; ação "radio" (com alvo)
        // → marcado quando o estado é igual ao alvo deste item.
        let checked = null;
        if (info.state) {
            if (target)
                checked = info.state.equal(target);
            else if (info.state.get_type_string() === 'b')
                checked = info.state.get_boolean();
        }

        return {
            label,
            icon,
            accel,
            checked,
            action,
            sensitive: info.exists && info.enabled,
            activate: info.exists ? () => info.group.activate_action(info.name, target) : null,
        };
    }

    /**
     * @param {string|null} fullName - ex.: "app.quit"
     * @returns {{group, name, exists, enabled, state}}
     */
    _actionInfo(fullName) {
        const none = {group: null, name: null, exists: false, enabled: false, state: null};
        if (!fullName)
            return none;
        const dot = fullName.indexOf('.');
        const group = this._groups[fullName.slice(0, dot)];
        const name = fullName.slice(dot + 1);
        if (!group || !group.has_action(name))
            return none;
        let state;
        try {
            state = group.get_action_state(name);
        } catch {
            state = null;
        }
        return {group, name, exists: true, enabled: group.get_action_enabled(name), state};
    }

    /**
     * Procura, em todos os menus do app, um item cuja ação seja uma das
     * conhecidas (ex.: "about" → app.about). Usado para mesclar "Sobre",
     * "Configurações" e "Sair" no menu do app em negrito.
     *
     * @param {string} key - chave de KNOWN_ACTIONS
     * @returns {object|null} nó de menu
     */
    findNode(key) {
        const names = KNOWN_ACTIONS[key] ?? [key];
        const search = nodes => {
            for (const node of nodes) {
                if (node.action && names.includes(node.action) && node.activate)
                    return node;
                if (Array.isArray(node.children)) {
                    const found = search(node.children);
                    if (found)
                        return found;
                }
            }
            return null;
        };
        const all = [];
        for (const model of [this._menubar, this._appMenu]) {
            if (model)
                all.push(...this._flatten(model));
        }
        return search(all);
    }

    /**
     * Nós com os submenus já resolvidos (listas em vez de funções), para
     * buscas. Profundidade limitada por segurança.
     */
    _flatten(model) {
        const resolve = (nodes, depth) => nodes.map(node => {
            if (typeof node.children !== 'function')
                return node;
            return {...node, children: depth < 6 ? resolve(node.children(), depth + 1) : []};
        });
        return resolve(this.buildModel(model), 0);
    }

    destroy() {
        for (const model of this._watched)
            model.disconnectObject(this);
        this._watched.clear();
        for (const group of Object.values(this._groups))
            group.disconnectObject(this);
        this._groups = {};
        this._menubar = null;
        this._appMenu = null;
    }
}
