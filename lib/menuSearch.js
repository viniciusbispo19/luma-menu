// SPDX-License-Identifier: GPL-3.0-or-later
// Busca do menu Ajuda, como no macOS: um campo no topo do menu que procura
// em TODOS os itens de menu do app atual e mostra o caminho de cada resultado
// ("Editar › Buscar › Buscar…"). Enter executa o primeiro resultado.
//
// Funciona com todas as camadas porque todas produzem o mesmo MODELO de menu
// (lista de nós, veja popup.js) — a busca só percorre esse modelo.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fillMenu} from './popup.js';

const MAX_RESULTS = 12;
const MAX_DEPTH = 6;
const PATH_SEPARATOR = ' › ';

/**
 * Texto para comparação: minúsculas e sem acentos ("Configurações" →
 * "configuracoes"), para "configuracao" achar "Configurações".
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
    return (text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Lista "plana" de todos os itens executáveis dos menus.
 *
 * @param {{title: string, nodes: object[]}[]} menus
 * @returns {{path: string[], node: object}[]}
 */
export function collectItems(menus) {
    const out = [];
    const walk = (nodes, path, depth) => {
        for (const node of nodes ?? []) {
            if (!node || node.visible === false || node.separator || node.header !== undefined || node.custom)
                continue;
            if (node.children !== undefined) {
                if (depth >= MAX_DEPTH || node.sensitive === false)
                    continue;
                // DBusMenu: peekChildren lê os filhos SEM avisar o app.
                let children = node.peekChildren?.() ?? node.children;
                if (typeof children === 'function')
                    children = children();
                // Filhos que dependem de disco/D-Bus (Promise) ficam de fora.
                if (Array.isArray(children))
                    walk(children, [...path, node.label], depth + 1);
                continue;
            }
            if (node.label && typeof node.activate === 'function' && node.sensitive !== false)
                out.push({path: [...path, node.label], node});
        }
    };
    for (const menu of menus)
        walk(menu.nodes, [menu.title], 0);
    return out;
}

/**
 * Procura e ordena: começa com a busca > começo de palavra > contém.
 * Todas as palavras digitadas precisam aparecer no rótulo ou no caminho.
 *
 * @param {{path: string[], node: object}[]} items
 * @param {string} query
 * @returns {{path: string[], node: object}[]}
 */
export function searchItems(items, query) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length)
        return [];
    const scored = [];
    for (const item of items) {
        const label = normalize(item.path[item.path.length - 1]);
        const full = normalize(item.path.join(' '));
        if (!words.every(w => full.includes(w)))
            continue;
        const first = words[0];
        let score = 3;
        if (label.startsWith(first))
            score = 0;
        else if (new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label))
            score = 1;
        else if (label.includes(first))
            score = 2;
        scored.push({item, score});
    }
    scored.sort((a, b) => a.score - b.score ||
        a.item.path.length - b.item.path.length);
    return scored.slice(0, MAX_RESULTS).map(s => s.item);
}

/**
 * O item com o campo de busca (não clicável; o foco vai para o campo).
 */
export const SearchItem = GObject.registerClass(
class LumaMenuSearchItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {Function} getMenus - () => [{title, nodes}] (lido a cada busca)
     * @param {object} options - opções de fillMenu (estilo de atalho)
     */
    _init(getMenus, options) {
        super._init({
            style_class: 'luma-menu-search-item',
            activate: false,
            reactive: true,
            can_focus: false,
            hover: false, // o campo não fica "azul" quando o mouse passa
        });
        this._getMenus = getMenus;
        this._options = options;
        this._items = null; // lista plana, montada na primeira tecla

        this.entry = new St.Entry({
            style_class: 'luma-menu-search-entry',
            hint_text: _('Search'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'luma-menu-search-icon',
            }),
        });
        this.add_child(this.entry);

        // Seção logo abaixo do campo, onde aparecem os resultados.
        this.results = new PopupMenu.PopupMenuSection();

        const text = this.entry.clutter_text;
        text.connect('text-changed', () => this._update());
        // Enter: executa o primeiro resultado.
        text.connect('activate', () => this._firstResult()?.activate(null));
        // Seta ↓: desce do campo para a lista de resultados.
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_Down && this._firstResult()) {
                this._firstResult().grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        text.add_action(keys);
    }

    _firstResult() {
        return this.results.firstMenuItem;
    }

    _update() {
        const query = this.entry.get_text();
        this.results.removeAll();
        if (!query.trim())
            return;
        this._items ??= collectItems(this._getMenus());
        const found = searchItems(this._items, query);
        if (!found.length) {
            fillMenu(this.results, [{label: _('No results'), sensitive: false}]);
            return;
        }
        fillMenu(this.results, found.map(({path, node}) => ({
            label: path.join(PATH_SEPARATOR),
            accel: node.accel,
            icon: node.icon,
            activate: node.activate,
        })), this._options);
    }

    /** Põe o foco no campo (chamado quando o menu Ajuda abre). */
    focus() {
        this._items = null; // o app pode ter mudado os menus
        this.entry.grab_key_focus();
    }
});
