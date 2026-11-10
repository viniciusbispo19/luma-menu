// SPDX-License-Identifier: GPL-3.0-or-later
// Um "título" da barra (ícone do sistema, nome do app, Arquivo, Editar…).
//
// É um PanelMenu.Button (o mesmo botão do relógio e do menu de status), com
// um LumaMenu (menu com cascata) no lugar do menu padrão. O conteúdo do menu
// vem de uma função `buildModel()` chamada toda vez que o menu vai abrir —
// assim os itens sempre refletem o estado atual (tela cheia, janelas abertas…).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
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
     * @param {boolean} [params.shrinkable] - pode encurtar com "…" se faltar espaço
     * @param {Function} params.buildModel - () => nós do menu (veja popup.js)
     * @param {object} params.bar - a MenuBar (fornece opções e aparência)
     */
    _init(params) {
        const {label = '', icon = null, accessibleName = null, styleClass = null,
            shrinkable = false, buildModel, bar} = params;
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
            // Sem espaço, o macOS encurta o NOME DO APP e mantém os menus
            // legíveis. Aqui: só títulos "shrinkable" (o nome do app) ganham
            // reticências; nos outros a largura mínima = largura do texto.
            if (shrinkable)
                this._label.add_style_class_name('luma-menu-app-label');
            else
                this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this.add_child(this._label);
        }

        this._onOpen = null;
        this.setMenu(new LumaMenu(this, bar.getAppearance()));
        this.menu.beforeOpen = () => {
            this._onOpen?.();
            this.rebuild();
        };
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

    /**
     * Função chamada quando o usuário abre este menu (ex.: avisar um app
     * DBusMenu com AboutToShow).
     *
     * @param {Function|null} onOpen
     */
    setOnOpen(onOpen) {
        this._onOpen = onOpen;
    }

    /**
     * Função chamada logo DEPOIS que o menu abriu.
     *
     * @param {Function|null} afterOpen
     */
    setAfterOpen(afterOpen) {
        this.menu.afterOpen = afterOpen;
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

    /**
     * Recria os itens do menu a partir do modelo.
     *
     * Se o menu está ABERTO e o conteúdo não mudou de verdade, não mexemos
     * nele: apps como o VS Code avisam "o menu mudou" (LayoutUpdated) logo
     * depois que o menu abre, e reconstruir à toa fecharia submenus abertos
     * e perderia o item sob o mouse.
     */
    rebuild() {
        const menu = this.menu;
        const model = this.getModel();
        const options = this._bar.getMenuOptions();
        const signature = modelSignature(model, options);
        if (menu.isOpen && signature === this._signature)
            return;
        // Com um submenu aberto, reconstruir fecharia o submenu na cara do
        // usuário. Adiamos: o menu é remontado na próxima vez que abrir.
        if (menu.isOpen && menu._openChild) {
            this._signature = null;
            return;
        }
        this._signature = signature;

        menu.removeAll();
        fillMenu(menu, model, options);
        // Um PopupMenu vazio se recusa a abrir; mostramos um traço cinza.
        if (menu.isEmpty())
            fillMenu(menu, [{label: '—', sensitive: false}]);
    }
});

/**
 * "Assinatura" de um modelo: o que aparece na tela (rótulos, atalhos, cinza,
 * ✓, submenus). Dois modelos com a mesma assinatura geram o mesmo menu.
 *
 * @param {object[]} nodes
 * @param {object} options
 * @returns {string}
 */
function modelSignature(nodes, options) {
    return JSON.stringify([options, nodes.map(n => [
        n.separator ? 1 : 0, n.header ?? '', n.label ?? '', n.accel ?? '',
        n.sensitive !== false && (n.children !== undefined || typeof n.activate === 'function' || n.custom !== undefined),
        n.checked ?? null, n.children !== undefined, n.visible !== false,
    ])]);
}
