// SPDX-License-Identifier: GPL-3.0-or-later
// A barra de menus: uma caixa horizontal no lado esquerdo do painel com os
// "títulos" (ícone do sistema, nome do app, Arquivo, Editar…).
//
// Cada título é um TitleButton (PanelMenu.Button). Registrar o menu de cada
// um no gerenciador de menus do painel dá o comportamento do macOS: com um
// menu aberto, passar o mouse em outro título troca de menu sem clicar.

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {resolveSystemIcon} from './icons.js';
import {SystemMenu} from './systemMenu.js';
import {getOsRelease} from './systemInfo.js';
import {logError} from './util.js';

export const MenuBar = GObject.registerClass(
class LumaMenuBar extends St.BoxLayout {
    /**
     * @param {Extension} extension - para getSettings() e a pasta da extensão
     */
    _init(extension) {
        super._init({
            name: 'lumaMenuBar',
            style_class: 'luma-menu-bar',
            // Ocupa a altura do painel: botões centralizados verticalmente.
            y_expand: true,
        });

        this.settings = extension.getSettings();
        this.dir = extension.dir;
        this._osRelease = {};
        this._titles = [];

        this._systemMenu = new SystemMenu(this);
        this._addTitle(this._systemMenu.button);

        // O ID da distro (para o ícone "Automático") é lido do disco de forma
        // assíncrona; quando chegar, atualizamos o ícone.
        this._destroyed = false;
        getOsRelease().then(os => {
            if (this._destroyed)
                return;
            this._osRelease = os;
            this._syncSystemIcon();
        }).catch(e => logError(e, 'lendo os-release'));

        this.settings.connectObject(
            'changed::system-icon', () => this._syncSystemIcon(),
            'changed::icon-style', () => this._syncSystemIcon(),
            'changed::custom-icon-path', () => this._syncSystemIcon(),
            'changed::icon-size', () => this._syncSystemIcon(),
            'changed::title-spacing', () => this._syncTitleStyle(),
            'changed::bold-app-name', () => this._syncTitleStyle(),
            'changed::menu-opacity', () => this._syncAppearance(),
            'changed::menu-radius', () => this._syncAppearance(),
            this);

        this.connect('destroy', () => this._onDestroy());
        this._syncSystemIcon();
        this._syncTitleStyle();
    }

    // ----- Opções usadas pelos títulos e menus --------------------------------

    /** @returns {object} opções para fillMenu() */
    getMenuOptions() {
        return {shortcutStyle: this.settings.get_string('shortcut-style')};
    }

    /** @returns {object} {opacity, radius} dos menus suspensos */
    getAppearance() {
        return {
            opacity: this.settings.get_int('menu-opacity') / 100,
            radius: this.settings.get_int('menu-radius'),
        };
    }

    /** @returns {Gio.Icon} o logo escolhido nas preferências */
    getSystemIcon() {
        return resolveSystemIcon({
            choice: this.settings.get_string('system-icon'),
            style: this.settings.get_string('icon-style'),
            customPath: this.settings.get_string('custom-icon-path'),
            osRelease: this._osRelease,
            iconsDir: this.dir.get_child('icons'),
        });
    }

    // ----- Títulos ------------------------------------------------------------

    /**
     * @param {TitleButton} button
     * @param {number} [position] - índice na barra (padrão: no fim)
     */
    _addTitle(button, position) {
        if (position === undefined)
            this.add_child(button.container);
        else
            this.insert_child_at_index(button.container, position);
        this._titles.push(button);
        button.connect('destroy', () => {
            this._titles = this._titles.filter(t => t !== button);
        });
        Main.panel.menuManager.addMenu(button.menu);
        this._applyTitleStyle(button);
    }

    _applyTitleStyle(button) {
        const pad = this.settings.get_int('title-spacing');
        // Estilo inline vence o tema: espaçamento lateral de cada título.
        button.style = `-natural-hpadding: ${pad}px; -minimum-hpadding: ${Math.round(pad / 2)}px;`;
    }

    _syncTitleStyle() {
        for (const button of this._titles)
            this._applyTitleStyle(button);
        const bold = this.settings.get_boolean('bold-app-name');
        if (bold)
            this.add_style_class_name('luma-menu-bold-app');
        else
            this.remove_style_class_name('luma-menu-bold-app');
    }

    _syncSystemIcon() {
        this._systemMenu.setIcon(this.getSystemIcon());
        this._systemMenu.button.setIconSize(this.settings.get_int('icon-size'));
    }

    _syncAppearance() {
        for (const button of this._titles)
            button.menu.setAppearance?.(this.getAppearance());
    }

    _onDestroy() {
        this._destroyed = true;
        this.settings.disconnectObject(this);
        this._systemMenu.destroy();
    }
});
