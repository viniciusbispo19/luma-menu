// SPDX-License-Identifier: GPL-3.0-or-later
// Um "título" da barra (ícone do sistema, nome do app, Arquivo, Editar…).
//
// É um PanelMenu.Button (o mesmo botão do relógio e do menu de status), com
// um LumaMenu (menu com cascata) no lugar do menu padrão. O conteúdo do menu
// vem de uma função `buildModel()` chamada toda vez que o menu vai abrir —
// assim os itens sempre refletem o estado atual (tela cheia, janelas abertas…).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {LumaMenu, fillMenu} from './popup.js';
import {logError} from './util.js';

export const TitleButton = GObject.registerClass(
class LumaMenuTitleButton extends PanelMenu.Button {
    /**
     * @param {object} params
     * @param {string} [params.label] - texto do título
     * @param {Gio.Icon} [params.icon] - ou um ícone (menu do sistema)
     * @param {string} [params.accessibleName]
     * @param {string} [params.styleClass]
     * @param {Function} params.buildModel - () => nós do menu (veja popup.js)
     * @param {object} params.bar - a MenuBar (fornece opções e aparência)
     */
    _init(params) {
        const {label = '', icon = null, accessibleName = null, styleClass = null,
            buildModel, bar} = params;
        // true = não criar o menu padrão; criamos o nosso logo abaixo.
        super._init(0.0, accessibleName ?? label, true);
        this.add_style_class_name('luma-menu-title');
        if (styleClass)
            this.add_style_class_name(styleClass);

        this._bar = bar;
        this._buildModel = buildModel;

        if (icon) {
            this._icon = new St.Icon({
                gicon: icon,
                style_class: 'luma-menu-system-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._icon);
        } else {
            this._label = new St.Label({
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
        }

        this.setMenu(new LumaMenu(this, bar.getAppearance()));
        this.menu.beforeOpen = () => this.rebuild();
        this.rebuild();
    }

    get title() {
        return this._label?.text ?? this.accessible_name;
    }

    /** @param {string} text */
    setLabel(text) {
        if (!this._label || this._label.text === text)
            return;
        this._label.text = text;
        this.accessible_name = text;
    }

    /** @param {Gio.Icon} gicon */
    setIcon(gicon) {
        if (this._icon)
            this._icon.gicon = gicon;
    }

    /** @param {number} size - pixels lógicos */
    setIconSize(size) {
        if (this._icon)
            this._icon.icon_size = size;
    }

    /**
     * Troca a função que gera o conteúdo. Não reconstrói agora (o menu se
     * reconstrói sozinho ao abrir) — exceto se estiver aberto neste momento.
     *
     * @param {Function} buildModel
     */
    setBuildModel(buildModel) {
        this._buildModel = buildModel;
        if (this.menu.isOpen)
            this.rebuild();
    }

    /** @returns {object[]} o modelo atual (usado pela busca do menu Ajuda) */
    getModel() {
        try {
            return this._buildModel() ?? [];
        } catch (e) {
            logError(e, `montando o menu "${this.title}"`);
            return [];
        }
    }

    /** Recria os itens do menu a partir do modelo. */
    rebuild() {
        const menu = this.menu;
        menu.removeAll();
        fillMenu(menu, this.getModel(), this._bar.getMenuOptions());
        // Um PopupMenu vazio se recusa a abrir; mostramos um traço cinza.
        if (menu.isEmpty())
            fillMenu(menu, [{label: '—', sensitive: false}]);
    }
});
