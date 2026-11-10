// SPDX-License-Identifier: GPL-3.0-or-later
// A barra de menus: uma caixa horizontal no lado esquerdo do painel com os
// "títulos" (ícone do sistema, nome do app, Arquivo, Editar…).
//
// Cada título é um TitleButton (PanelMenu.Button). Registrar o menu de cada
// um no gerenciador de menus do painel dá o comportamento do macOS: com um
// menu aberto, passar o mouse em outro título troca de menu sem clicar.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {VirtualKeyboard} from './actions.js';
import {buildAppMenu} from './appMenu.js';
import {FallbackMenus, findHelpId} from './fallbackMenus.js';
import {resolveSystemIcon} from './icons.js';
import {AppActions} from './sources/actionSource.js';
import {DBusMenuSource} from './sources/dbusMenuSource.js';
import {GtkMenuSource} from './sources/gtkMenuSource.js';
import {getXid} from './sources/registrar.js';
import {SystemMenu} from './systemMenu.js';
import {getOsRelease} from './systemInfo.js';
import {TitleButton} from './titleButton.js';
import {TimeoutRegistry, logError} from './util.js';
import {FocusTracker, appDisplayName} from './windowTracker.js';

export const MenuBar = GObject.registerClass(
class LumaMenuBar extends St.BoxLayout {
    /**
     * @param {Extension} extension - para getSettings() e a pasta da extensão
     * @param {Registrar|null} registrar - camada B (null se desativada)
     */
    _init(extension, registrar) {
        super._init({
            name: 'lumaMenuBar',
            style_class: 'luma-menu-bar',
            // Ocupa a altura do painel: botões centralizados verticalmente.
            y_expand: true,
            // Se nem com o transbordamento couber tudo (muitos menus e muitos
            // ícones de status), cortamos na borda em vez de desenhar por cima
            // dos ícones. Os menus suspensos não são filhos da barra (vivem no
            // uiGroup), então não são cortados.
            clip_to_allocation: true,
        });

        this.settings = extension.getSettings();
        this.dir = extension.dir;
        this._osRelease = {};
        this._titles = [];

        this._timers = new TimeoutRegistry();
        this._refreshTimer = 0;
        this._keyboard = new VirtualKeyboard();
        this._helpIds = new Map(); // app id → manual do Yelp (ou null)
        this._menuButtons = []; // títulos dinâmicos (Arquivo, Editar…)
        this._fallback = null;
        this._appSource = null; // menus reais da janela em foco (camada A ou B)
        this._registrar = null;

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
            shrinkable: true,
            buildModel: () => this._buildAppMenu(),
            bar: this,
        });
        this._addTitle(this._appButton);
        this._focus.connectObject('changed', () => this._onFocusChanged(), this);
        this.setRegistrar(registrar);

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
            'changed::show-fallback-menus', () => this._updateMenus(),
            'changed::show-file-menu', () => this._updateMenus(),
            'changed::show-edit-menu', () => this._updateMenus(),
            'changed::show-view-menu', () => this._updateMenus(),
            'changed::show-window-menu', () => this._updateMenus(),
            'changed::show-help-menu', () => this._updateMenus(),
            'changed::ignored-apps', () => this._onFocusChanged(true),
            this);

        this.connect('destroy', () => this._onDestroy());
        this._syncSystemIcon();
        this._syncTitleStyle();
        this._ready = true;
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

    /**
     * O app/janela está na lista "apps ignorados" das preferências? Esses
     * usam só os menus padrão (útil se um app exporta menus problemáticos).
     */
    _isIgnored(app, window) {
        const ignored = this.settings.get_strv('ignored-apps').map(x => x.toLowerCase());
        const keys = [app?.get_id()?.replace(/\.desktop$/, ''), window?.get_wm_class()]
            .filter(Boolean).map(x => x.toLowerCase());
        return keys.some(k => ignored.includes(k));
    }

    /**
     * Troca o Registrar (camada B) — a extensão o liga/desliga ao vivo pela
     * preferência. Quando um app registra a janela em foco, atualizamos.
     *
     * @param {Registrar|null} registrar
     */
    setRegistrar(registrar) {
        this._registrar?.disconnectObject(this);
        this._registrar = registrar;
        this._registrar?.connectObject('changed', (_r, xid) => {
            if (xid === getXid(this._focus.window))
                this._onFocusChanged(true);
        }, this);
        if (this._ready)
            this._onFocusChanged(true);
    }

    /**
     * Escolhe a fonte dos menus da janela em foco, da melhor para a mais
     * genérica:
     *   A. menus GTK exportados (org.gtk.Menus);
     *   B. DBusMenu registrado no Registrar (apps XWayland: Qt, Electron…);
     *   D. menus padrão (escolhidos depois, em _updateMenus).
     *
     * @param {boolean} force - recriar mesmo se a janela não mudou
     */
    _syncMenuSource(force) {
        const {app, window} = this._focus;
        if (!force && this._appSource && this._appSourceWindow === window)
            return;
        this._appSource?.disconnectObject(this);
        this._appSource?.destroy();
        this._appSource = null;
        this._appSourceWindow = window;

        if (!window || this._isIgnored(app, window))
            return;
        if (GtkMenuSource.isAvailable(window)) {
            this._appSource = new GtkMenuSource(window);
        } else {
            const entry = this._registrar?.lookup(window);
            if (entry)
                this._appSource = new DBusMenuSource(entry.service, entry.path);
        }
        this._appSource?.connectObject('changed', () => this._scheduleRefresh(), this);
    }

    _onFocusChanged(force = false) {
        const {app, window} = this._focus;
        this._syncMenuSource(force);
        this._appButton.setLabel(appDisplayName(app, window));
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

        // Procura (em segundo plano) se o app tem manual para o menu Ajuda.
        const appId = app?.get_id();
        if (appId && !this._helpIds.has(appId)) {
            this._helpIds.set(appId, null);
            findHelpId(app).then(id => {
                if (this._destroyed || !id)
                    return;
                this._helpIds.set(appId, id);
                if (this._focus.app?.get_id() === appId)
                    this._updateMenus();
            }).catch(e => logError(e, 'procurando manual'));
        }

        this._updateMenus();
    }

    /** Contexto passado às fontes de menu: tudo sobre o foco atual. */
    _menuContext() {
        const {app, window, isDesktop} = this._focus;
        return {
            app,
            window,
            isDesktop,
            actions: this._actions,
            keyboard: this._keyboard,
            helpId: app ? this._helpIds.get(app.get_id()) ?? null : null,
        };
    }

    /**
     * Decide quais menus aparecem depois do nome do app e atualiza os títulos.
     */
    _updateMenus() {
        if (this._destroyed)
            return;
        this._fallback = new FallbackMenus(this._menuContext());

        let defs;
        if (this._appSource?.hasMenus) {
            // Camadas A/B: os menus reais do app substituem Arquivo…Ajuda.
            defs = this._appSource.getMenus();
        } else if (this.settings.get_boolean('show-fallback-menus')) {
            defs = this._fallback.getMenus(this.settings);
        } else {
            defs = [];
        }

        // Menu Ajuda: se o app já tem o dele, ele vira o "nosso" (a busca da
        // Fase 7 entra no topo dele); senão acrescentamos o padrão.
        const helpTitles = ['help', 'ajuda', _('Help').toLowerCase()];
        const appHelp = defs.find(d => helpTitles.includes(d.title.toLowerCase()));
        if (appHelp) {
            const appBuild = appHelp.build;
            appHelp.id = 'help';
            appHelp.build = () => this._buildHelpMenu(appBuild());
        } else if (this.settings.get_boolean('show-help-menu')) {
            defs.push({
                id: 'help',
                title: _('Help'),
                build: () => this._buildHelpMenu(this._fallback.buildHelpItems()),
            });
        }

        this._setMenuTitles(defs);
        this._refreshTitles();
    }

    /**
     * Conteúdo do menu Ajuda (a Fase 7 acrescenta a busca no topo).
     *
     * @param {object[]} items - itens de ajuda (do app ou padrão)
     * @returns {object[]}
     */
    _buildHelpMenu(items) {
        return items;
    }

    /**
     * Reaproveita os botões existentes (só troca rótulo e conteúdo) e cria ou
     * remove os que faltam/sobram. Reaproveitar evita "piscar" a barra a cada
     * troca de foco.
     *
     * @param {{id: string, title: string, build: Function}[]} defs
     */
    _setMenuTitles(defs) {
        defs.forEach((def, i) => {
            let button = this._menuButtons[i];
            if (!button) {
                button = new TitleButton({label: def.title, buildModel: def.build, bar: this});
                this._addTitle(button);
                this._menuButtons.push(button);
            }
            button.setLabel(def.title);
            button.menuId = def.id;
            button.setOnOpen(def.onOpen ?? null);
            button.setBuildModel(def.build);
        });
        while (this._menuButtons.length > defs.length)
            this._menuButtons.pop().destroy();
    }

    _buildAppMenu() {
        // "Sobre", "Configurações" e "Sair" achados nos menus reais do app.
        const src = this._appSource;
        const merged = src ? {
            about: src.findNode('about'),
            preferences: src.findNode('preferences'),
            quit: src.findNode('quit'),
        } : {};
        return buildAppMenu({
            app: this._focus.app,
            name: appDisplayName(this._focus.app, this._focus.window),
            isDesktop: this._focus.isDesktop,
            actions: this._actions,
            merged,
        });
    }

    /**
     * Agrupa várias mudanças seguidas (ações do app, menus D-Bus chegando)
     * numa única atualização da barra, 50 ms depois.
     */
    _scheduleRefresh() {
        if (this._refreshTimer)
            return;
        this._refreshTimer = this._timers.add(50, () => {
            this._refreshTimer = 0;
            this._updateMenus();
        });
    }

    /**
     * Reconstrói só o menu que estiver ABERTO. Os fechados se reconstroem ao
     * abrir (TitleButton.beforeOpen) — assim trocar de janela é instantâneo,
     * mesmo com muitos menus.
     */
    _refreshTitles() {
        for (const button of this._titles) {
            if (button.menu.isOpen)
                button.rebuild();
        }
    }

    // ----- Largura: ocupar o espaço livre do painel ---------------------------
    //
    // O Panel do GNOME limita a caixa da esquerda a METADE da largura do painel
    // (ui/panel.js, vfunc_allocate). Apps com muitos menus (ex.: LibreOffice)
    // não caberiam. Então, se recebermos menos que a nossa largura natural, nos
    // estendemos até onde começam os itens do centro/direita (menos uma margem).
    // O St não corta filhos que passam da borda do pai, e os cliques funcionam.

    vfunc_allocate(box) {
        const [, natural] = this.get_preferred_width(-1);
        const given = box.x2 - box.x1;
        if (natural > given && this._canOverflow()) {
            const limit = this._overflowLimit(box);
            if (limit > given) {
                box = box.copy();
                box.x2 = box.x1 + Math.min(natural, limit);
            }
        }
        super.vfunc_allocate(box);
    }

    /** Só transbordamos se formos o último item visível da caixa da esquerda. */
    _canOverflow() {
        const parent = this.get_parent();
        if (!parent || this.get_text_direction() === Clutter.TextDirection.RTL)
            return false;
        const siblings = parent.get_children();
        return siblings.slice(siblings.indexOf(this) + 1).every(c => !c.visible || c.width === 0);
    }

    /**
     * Largura máxima até o primeiro item visível do centro ou da direita
     * (posições do quadro anterior — o painel aloca a esquerda primeiro).
     *
     * @param {Clutter.ActorBox} box - nossa caixa, relativa ao pai
     * @returns {number}
     */
    _overflowLimit(box) {
        const MARGIN = 20;
        const parentX = this.get_parent().get_allocation_box().x1;
        const start = parentX + box.x1;
        let end = Infinity;
        for (const area of [Main.panel._centerBox, Main.panel._rightBox]) {
            const areaX = area.get_allocation_box().x1;
            for (const child of area.get_children()) {
                if (child.visible && child.width > 0) {
                    end = Math.min(end, areaX + child.get_allocation_box().x1);
                    break;
                }
            }
        }
        return end === Infinity ? box.x2 - box.x1 : Math.max(0, end - start - MARGIN);
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
        this._keyboard.destroy();
        this._actions.group?.disconnectObject(this);
        this._appSource?.disconnectObject(this);
        this._appSource?.destroy();
        this._appSource = null;
        this._registrar?.disconnectObject(this);
        this._registrar = null;
        this._focus.disconnectObject(this);
        this._focus.destroy();
        this.settings.disconnectObject(this);
        this._systemMenu.destroy();
    }
});
