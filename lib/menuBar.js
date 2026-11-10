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

import {buildAppMenu} from './appMenu.js';
import {resolveSystemIcon} from './icons.js';
import {AppActions} from './sources/actionSource.js';
import {SystemMenu} from './systemMenu.js';
import {getOsRelease} from './systemInfo.js';
import {TitleButton} from './titleButton.js';
import {TimeoutRegistry, logError} from './util.js';
import {FocusTracker} from './windowTracker.js';

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

        this._timers = new TimeoutRegistry();
        this._refreshTimer = 0;

        this._systemMenu = new SystemMenu(this);
        this._addTitle(this._systemMenu.button);

        // Acompanha a janela/app em foco. Criado ANTES dos botões, porque o
        // botão do app já monta o menu no construtor e precisa saber o foco.
        this._focus = new FocusTracker();
        this._actions = new AppActions(null);

        // Menu do app em foco (nome em negrito).
        this._appButton = new TitleButton({
            label: '',
            styleClass: 'luma-menu-app-title',
            buildModel: () => this._buildAppMenu(),
            bar: this,
        });
        this._addTitle(this._appButton);
        this._focus.connectObject('changed', () => this._onFocusChanged(), this);

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
        this._onFocusChanged();
    }

    // ----- Foco ---------------------------------------------------------------

    /** @returns {FocusTracker} */
    get focus() {
        return this._focus;
    }

    /** @returns {AppActions} GActions do app em foco (camada C) */
    get appActions() {
        return this._actions;
    }

    _onFocusChanged() {
        const {app, window} = this._focus;
        this._appButton.setLabel(app?.get_name() ?? window?.get_title() ?? '');
        this._appButton.visible = Boolean(app || window);

        // Troca o grupo de ações observado: se o app ligar/desligar uma ação
        // (ex.: "Desfazer" fica disponível), o menu aberto se atualiza.
        this._actions.group?.disconnectObject(this);
        this._actions = new AppActions(app);
        this._actions.group?.connectObject(
            'action-added', () => this._scheduleRefresh(),
            'action-removed', () => this._scheduleRefresh(),
            'action-enabled-changed', () => this._scheduleRefresh(),
            'action-state-changed', () => this._scheduleRefresh(),
            this);

        this._refreshTitles();
    }

    _buildAppMenu() {
        return buildAppMenu({
            app: this._focus.app,
            isDesktop: this._focus.isDesktop,
            actions: this._actions,
        });
    }

    /** Agrupa várias mudanças seguidas numa única reconstrução (50 ms). */
    _scheduleRefresh() {
        if (this._refreshTimer)
            return;
        this._refreshTimer = this._timers.add(50, () => {
            this._refreshTimer = 0;
            this._refreshTitles();
        });
    }

    /** Reconstrói os menus (os fechados também, para não abrirem vazios). */
    _refreshTitles() {
        for (const button of this._titles) {
            if (button !== this._systemMenu.button)
                button.rebuild();
        }
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
        this._timers.clear();
        this._actions.group?.disconnectObject(this);
        this._focus.disconnectObject(this);
        this._focus.destroy();
        this.settings.disconnectObject(this);
        this._systemMenu.destroy();
    }
});
