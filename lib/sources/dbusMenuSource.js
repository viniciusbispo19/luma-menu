// SPDX-License-Identifier: GPL-3.0-or-later
// Camada B: lê menus no protocolo com.canonical.dbusmenu (Qt, Electron,
// Chromium, LibreOffice no X11…), depois que o app registrou a janela no
// nosso Registrar.
//
// O protocolo, resumido:
//   GetLayout(pai, profundidade, propriedades) → árvore de itens
//     cada item = (id, {label, enabled, visible, type, toggle-type,
//                       toggle-state, shortcut, icon-name, icon-data,
//                       children-display}, [filhos])
//   AboutToShow(id)        → avisa que um submenu vai abrir (o app pode preenchê-lo)
//   Event(id, "clicked"…)  → o usuário clicou no item
//   sinais LayoutUpdated / ItemsPropertiesUpdated → o menu mudou
//
// Tudo é assíncrono e com tratamento de erro: se o app fechar ou travar,
// a chamada falha, registramos (se for inesperado) e a barra segue normal.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {cleanMnemonic} from './gtkMenuSource.js';
import {dbusMenuShortcutToAccel} from '../shortcuts.js';
import {debug, isExpectedDBusError, logError} from '../util.js';

const IFACE = 'com.canonical.dbusmenu';

/**
 * Rótulo DBusMenu → texto. Além do "_" do protocolo, alguns apps Qt deixam
 * escapar o mnemônico no estilo Qt ("&Abrir"); removemos o "&" quando ele
 * está no início de uma palavra ("Tom & Jerry" fica intacto).
 *
 * @param {string} label
 * @returns {string}
 */
function cleanLabel(label) {
    return cleanMnemonic(label).replace(/(^|\s)&(?=\p{L})/gu, '$1');
}
const CALL_TIMEOUT = 2000; // ms — um app travado não pode travar a barra

// Rótulos usados para achar "Sobre", "Preferências" e "Sair" nos menus de
// apps que não usam GActions (DBusMenu não tem nomes de ação).
const MERGE_PATTERNS = {
    about: /^(about|sobre)\b/i,
    preferences: /^(preferences|settings|options|configura|preferências|opções)/i,
    quit: /^(quit|exit|sair)\b/i,
};

export class DBusMenuSource extends Signals.EventEmitter {
    /**
     * @param {string} service - nome D-Bus único do app (ex.: ":1.42")
     * @param {string} path - caminho do objeto do menu
     */
    constructor(service, path) {
        super();
        this._service = service;
        this._path = path;
        this._root = null; // árvore já convertida: {id, props, children}
        this._cancellable = new Gio.Cancellable();
        this._fetching = false;
        this._fetchAgain = false;

        const conn = Gio.DBus.session;
        this._signalIds = ['LayoutUpdated', 'ItemsPropertiesUpdated'].map(member =>
            conn.signal_subscribe(service, IFACE, member, path, null,
                Gio.DBusSignalFlags.NONE, () => this._fetch()));
        this._fetch();
    }

    async _call(method, params, replyType) {
        const reply = await Gio.DBus.session.call(this._service, this._path, IFACE,
            method, params, replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, CALL_TIMEOUT, this._cancellable);
        return reply;
    }

    /** Busca a árvore inteira (agrupando pedidos que chegam durante a busca). */
    async _fetch() {
        if (this._fetching) {
            this._fetchAgain = true;
            return;
        }
        this._fetching = true;
        try {
            do {
                this._fetchAgain = false;
                const reply = await this._call('GetLayout',
                    new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
                const [, layout] = reply.recursiveUnpack();
                this._root = convert(layout);
            } while (this._fetchAgain && !this._cancellable.is_cancelled());
            this.emit('changed');
        } catch (e) {
            if (!isExpectedDBusError(e))
                logError(e, `DBusMenu ${this._service}${this._path}`);
        } finally {
            this._fetching = false;
        }
    }

    /** Avisa o app que um (sub)menu vai abrir — alguns só o preenchem aí. */
    _aboutToShow(id) {
        this._call('AboutToShow', new GLib.Variant('(i)', [id]), '(b)')
            .then(reply => {
                const [needUpdate] = reply.deepUnpack();
                if (needUpdate)
                    this._fetch();
            })
            .catch(e => {
                if (!isExpectedDBusError(e))
                    debug(`AboutToShow(${id}) falhou: ${e.message}`);
            });
    }

    /**
     * AboutToShow + GetLayout só de um ramo (um submenu).
     *
     * @param {number} id
     * @returns {Promise<object|null>} o ramo convertido
     */
    async _fetchSubtree(id) {
        try {
            await this._call('AboutToShow', new GLib.Variant('(i)', [id]), '(b)');
        } catch (e) {
            if (!isExpectedDBusError(e))
                debug(`AboutToShow(${id}) falhou: ${e.message}`);
        }
        try {
            const reply = await this._call('GetLayout',
                new GLib.Variant('(iias)', [id, -1, []]), '(u(ia{sv}av))');
            return convert(reply.recursiveUnpack()[1]);
        } catch (e) {
            if (!isExpectedDBusError(e))
                logError(e, `GetLayout(${id})`);
            return null;
        }
    }

    /**
     * Pede ao app que preencha os menus de topo ainda vazios — usado quando
     * o menu Ajuda abre, para a busca encontrar os itens de todos os menus.
     */
    prefetchAll() {
        for (const item of this._root?.children ?? []) {
            if (isVisible(item) && item.children.length === 0)
                this._aboutToShow(item.id);
        }
    }

    _clicked(id) {
        this._call('Event', new GLib.Variant('(isvu)',
            [id, 'clicked', GLib.Variant.new_int32(0), global.get_current_time()]), null)
            .catch(e => {
                if (!isExpectedDBusError(e))
                    logError(e, `clicando no item ${id}`);
            });
        debug(`DBusMenu: clique no item ${id}`);
    }

    /** @returns {boolean} já temos menus para mostrar? */
    get hasMenus() {
        return (this._root?.children.filter(isVisible).length ?? 0) > 0;
    }

    /** @returns {{id: string, title: string, build: Function}[]} */
    getMenus() {
        return (this._root?.children ?? [])
            .filter(item => isVisible(item) && item.props.type !== 'separator')
            .map(item => ({
                id: `dbusmenu:${item.id}`,
                title: cleanLabel(item.props.label ?? ''),
                // AboutToShow só quando o usuário ABRE o menu — nunca ao montar
                // o modelo: o app responde com LayoutUpdated, que remonta o
                // modelo; se a montagem chamasse AboutToShow, viraria um ciclo.
                onOpen: () => this._aboutToShow(item.id),
                // Ainda vazio (o app preenche após o AboutToShow): mostra "…"
                // até o LayoutUpdated chegar e o menu ser remontado.
                build: () => (item.children.length
                    ? this._toNodes(item.children)
                    : [{label: '…', sensitive: false}]),
            }));
    }

    _toNodes(items) {
        const nodes = [];
        for (const item of items) {
            if (!isVisible(item))
                continue;
            const p = item.props;
            if (p.type === 'separator') {
                nodes.push({separator: true});
                continue;
            }
            const label = cleanLabel(p.label ?? '');
            const icon = iconFor(p);
            if (p['children-display'] === 'submenu' || item.children.length > 0) {
                nodes.push({
                    label,
                    icon,
                    sensitive: p.enabled !== false,
                    children: () => {
                        // Já temos os filhos: mostra na hora (e avisa o app,
                        // que pode atualizá-los).
                        if (item.children.length) {
                            this._aboutToShow(item.id);
                            return this._toNodes(item.children);
                        }
                        // Apps como o Electron só preenchem o submenu depois
                        // do AboutToShow: abrimos com "…" e buscamos o ramo.
                        return this._fetchSubtree(item.id)
                            .then(sub => this._toNodes(sub?.children ?? []));
                    },
                    // Para a busca do menu Ajuda: lê os filhos SEM avisar o app.
                    peekChildren: () => this._toNodes(item.children),
                });
                continue;
            }
            const toggle = p['toggle-type'];
            nodes.push({
                label,
                icon,
                accel: dbusMenuShortcutToAccel(p.shortcut),
                checked: toggle === 'checkmark' || toggle === 'radio'
                    ? p['toggle-state'] === 1
                    : null,
                sensitive: p.enabled !== false,
                activate: () => this._clicked(item.id),
            });
        }
        return nodes;
    }

    /**
     * Item para mesclar no menu do app ("Sobre", "Preferências", "Sair"),
     * procurado pelo rótulo.
     *
     * @param {string} key - about | preferences | quit
     * @returns {object|null}
     */
    findNode(key) {
        const pattern = MERGE_PATTERNS[key];
        if (!pattern || !this._root)
            return null;
        const search = items => {
            for (const item of items) {
                if (!isVisible(item))
                    continue;
                const label = cleanLabel(item.props.label ?? '');
                if (item.children.length === 0 && pattern.test(label) && item.props.enabled !== false) {
                    return {
                        label,
                        accel: dbusMenuShortcutToAccel(item.props.shortcut),
                        activate: () => this._clicked(item.id),
                    };
                }
                const found = search(item.children);
                if (found)
                    return found;
            }
            return null;
        };
        return search(this._root.children);
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._signalIds)
            Gio.DBus.session.signal_unsubscribe(id);
        this._signalIds = [];
        this._root = null;
    }
}

/** (id, props, [variants de filhos]) já desempacotado → objeto. */
function convert(layout) {
    const [id, props, children] = layout;
    return {
        id,
        props: props ?? {},
        children: (children ?? []).map(child => convert(child)),
    };
}

function isVisible(item) {
    return item.props.visible !== false;
}

/** Ícone do item: nome do tema (icon-name) ou PNG embutido (icon-data). */
function iconFor(props) {
    try {
        if (props['icon-name'])
            return Gio.ThemedIcon.new(props['icon-name']);
        if (props['icon-data']?.length)
            return Gio.BytesIcon.new(new GLib.Bytes(props['icon-data']));
    } catch {
        // ícone inválido: segue sem ícone
    }
    return null;
}
