// SPDX-License-Identifier: GPL-3.0-or-later
// As funções do Isle (github.com/zickrian/isle) adaptadas à barra do macOS.
//
// No Isle, tudo mora numa "ilha" no centro do topo da tela. Aqui a barra
// continua igual à do macOS, e a mesma ideia se distribui assim:
//
//   - o relógio fica no CANTO DIREITO da barra (depois dos ícones de status),
//     no lugar do relógio do GNOME;
//   - clicar no relógio abre o PAINEL com as abas do Isle (Música, Calendário,
//     Notificações, Foco, Lembretes), descendo alinhado à direita — como a
//     Central de Controle/Notificações do Mac;
//   - as "atividades vivas" (música, timer) aparecem ao lado do relógio, e os
//     alertas numa caixinha no canto superior direito (próximas fases).
//
// Este arquivo é o "controlador": cria o relógio e o painel, escolhe a página
// ao abrir e faz (e DESFAZ no destroy) as mudanças no Shell:
//   1. esconde o relógio do GNOME (dateMenu);
//   2. Super+V (atalho do GNOME para o calendário) passa a abrir a página
//      Calendário do nosso painel.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClockButton} from './clockButton.js';
import {CalendarPage} from './pages/calendarPage.js';
import {debug, logError} from '../util.js';

/** Nome do nosso botão em Main.panel.statusArea. */
const STATUS_ROLE = 'luma-menu-clock';
/** A página escolhida à mão vale por 5 minutos (como no Isle). */
const PAGE_MEMORY = 5 * 60 * 1000 * 1000; // µs
/** Troca de página: desliza e aparece (ms / px). */
const PAGE_SLIDE_TIME = 200;
const PAGE_SLIDE_OFFSET = 32;

// Se outra extensão mostrar o relógio do GNOME de novo, escondemos — no
// máximo 3 vezes a cada 10 s, para nunca virar uma "briga" infinita.
const MAX_REHIDE = 3;
const REHIDE_WINDOW = 10 * 1000 * 1000; // µs

/** Páginas que existem nesta versão (as outras chegam na Fase 2). */
const PAGE_FACTORIES = {
    calendar: settings => new CalendarPage(settings),
};

export class Island {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._injections = new InjectionManager();
        this._pages = [];
        this._currentPage = null;
        this._pickedPage = {id: null, time: 0};
        this._dateMenuHiddenByUs = false;
        this._rehides = [];

        // ----- Relógio + painel -----
        this._button = new ClockButton(settings, this._appearance());
        const menu = this._button.menu;
        // O painel é um único "item" sem destaque, com as abas e a página.
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: 'luma-island-panel',
            reactive: false,
            can_focus: false,
            activate: false,
        });
        item.add_child(this._buildPanel());
        menu.addMenuItem(item);
        menu.beforeOpen = () => this._onBeforeOpen();
        // "menu-closed" chega DEPOIS da animação de fechar: só então a
        // página devolve o que pegou emprestado (o calendário do GNOME).
        menu.connectObject('menu-closed', () => this._onClosed(), this);
        this._buildPages();

        // Último item da caixa da direita: depois dos ícones de status, onde
        // fica o relógio no macOS. addToStatusArea também registra o menu no
        // gerenciador de menus do painel (Esc, clicar fora, trocar com o mouse).
        Main.panel.addToStatusArea(STATUS_ROLE, this._button,
            Main.panel._rightBox.get_n_children(), 'right');

        settings.connectObject(
            'changed::menu-opacity', () => this._syncAppearance(),
            'changed::menu-radius', () => this._syncAppearance(),
            'changed::island-pages', () => this._rebuildPages(),
            this);

        this._hideDateMenu();
        // Super+V abre a página Calendário (o relógio do GNOME está escondido).
        const island = this;
        this._injections.overrideMethod(Main.panel, 'toggleCalendar', () => function() {
            island.toggle('calendar');
        });
    }

    // ----- Construção ---------------------------------------------------------------

    _buildPanel() {
        const panel = new St.BoxLayout({
            style_class: 'luma-island-open',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._tabs = new St.BoxLayout({
            style_class: 'luma-island-tabs',
            x_align: Clutter.ActorAlign.CENTER,
        });
        panel.add_child(this._tabs);

        this._stack = new St.Widget({
            style_class: 'luma-island-page',
            layout_manager: new Clutter.BinLayout(),
        });
        panel.add_child(this._stack);
        return panel;
    }

    _buildPages() {
        for (const id of this._settings.get_strv('island-pages')) {
            const factory = PAGE_FACTORIES[id];
            if (!factory || this._pages.some(p => p.id === id))
                continue;
            try {
                const page = factory(this._settings);
                const tab = new St.Button({
                    style_class: 'luma-island-tab',
                    label: page.title,
                    can_focus: true,
                });
                tab.connect('clicked', () => {
                    this._pickedPage = {id: page.id, time: GLib.get_monotonic_time()};
                    this._showPage(this._pages.find(p => p.page === page), true);
                });
                this._tabs.add_child(tab);
                this._pages.push({id, page, tab});
            } catch (e) {
                logError(e, `criando a página ${id}`);
            }
        }
        this._syncTabs();
    }

    _rebuildPages() {
        this._button.menu.close({animate: false});
        this._destroyPages();
        this._buildPages();
    }

    _destroyPages() {
        // Primeiro escondemos (a página Calendário devolve o calendário do
        // GNOME), depois destruímos.
        this._hideCurrentPage();
        for (const {page, tab} of this._pages) {
            page.destroy();
            tab.destroy();
        }
        this._pages = [];
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    /**
     * Abre o painel na página pedida; se ela já está aberta, fecha (Super+V).
     *
     * @param {string} pageId
     */
    toggle(pageId) {
        const menu = this._button.menu;
        const entry = this._pages.find(p => p.id === pageId);
        if (menu.isOpen && this._currentPage === entry) {
            menu.close();
            return;
        }
        this._requestedPage = entry ?? null;
        if (menu.isOpen)
            this._showPage(entry, true);
        else
            menu.open();
    }

    _onBeforeOpen() {
        const entry = this._requestedPage ?? this._choosePage();
        this._requestedPage = null;
        if (entry) {
            debug('painel do relógio: abrindo na página', entry.id);
            this._showPage(entry, false);
        }
    }

    _onClosed() {
        if (!this._button.menu.isOpen)
            this._hideCurrentPage();
    }

    /**
     * Página ao abrir (regra do Isle): a escolhida à mão nos últimos 5
     * minutos; senão uma página "viva" (música tocando, timer rodando,
     * notificações não vistas); senão a primeira da lista.
     */
    _choosePage() {
        const {id, time} = this._pickedPage;
        if (id && GLib.get_monotonic_time() - time < PAGE_MEMORY) {
            const picked = this._pages.find(p => p.id === id);
            if (picked)
                return picked;
        }
        return this._pages.find(p => p.page.isLive) ?? this._pages[0] ?? null;
    }

    _showPage(entry, animate) {
        if (!entry || this._currentPage === entry)
            return;
        const old = this._currentPage;
        const oldIndex = old ? this._pages.indexOf(old) : -1;
        this._hideCurrentPage();

        this._currentPage = entry;
        this._stack.add_child(entry.page.actor);
        try {
            entry.page.show();
        } catch (e) {
            logError(e, `mostrando a página ${entry.id}`);
        }
        this._syncTabs();

        // Desliza a partir do lado da aba anterior.
        const actor = entry.page.actor;
        actor.remove_all_transitions();
        if (animate && old) {
            const dir = this._pages.indexOf(entry) > oldIndex ? 1 : -1;
            actor.opacity = 0;
            actor.translation_x = dir * PAGE_SLIDE_OFFSET;
            actor.ease({
                opacity: 255,
                translation_x: 0,
                duration: PAGE_SLIDE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            actor.opacity = 255;
            actor.translation_x = 0;
        }
    }

    _hideCurrentPage() {
        const entry = this._currentPage;
        if (!entry)
            return;
        this._currentPage = null;
        entry.page.actor.remove_all_transitions();
        entry.page.hide();
        this._stack.remove_child(entry.page.actor);
        this._syncTabs();
    }

    _syncTabs() {
        for (const entry of this._pages) {
            if (entry === this._currentPage)
                entry.tab.add_style_pseudo_class('checked');
            else
                entry.tab.remove_style_pseudo_class('checked');
        }
    }

    // ----- Aparência e relógio do GNOME -------------------------------------------

    /** @returns {{opacity: number, radius: number}} a dos menus do Luma Menu */
    _appearance() {
        return {
            opacity: this._settings.get_int('menu-opacity') / 100,
            radius: this._settings.get_int('menu-radius'),
        };
    }

    _syncAppearance() {
        this._button.menu.setAppearance(this._appearance());
    }

    _hideDateMenu() {
        const container = Main.panel.statusArea.dateMenu?.container;
        if (!container)
            return;
        if (container.visible) {
            container.hide();
            this._dateMenuHiddenByUs = true;
        }
        // Se alguém mostrar o relógio do GNOME de novo (ex.: outra extensão
        // sendo desativada), escondemos — com limite contra "brigas".
        container.connectObject('notify::visible', () => {
            if (!container.visible)
                return;
            const now = GLib.get_monotonic_time();
            this._rehides = this._rehides.filter(t => now - t < REHIDE_WINDOW);
            if (this._rehides.length >= MAX_REHIDE)
                return;
            this._rehides.push(now);
            container.hide();
            this._dateMenuHiddenByUs = true;
        }, this);
    }

    _restoreDateMenu() {
        const container = Main.panel.statusArea.dateMenu?.container;
        container?.disconnectObject(this);
        // Só mostramos de volta se FOMOS nós que escondemos (se outra
        // extensão, como a Hiragana Clock, já o tinha escondido, fica como ela
        // deixou).
        if (this._dateMenuHiddenByUs)
            container?.show();
        this._dateMenuHiddenByUs = false;
    }

    // ----- Fim ----------------------------------------------------------------------

    destroy() {
        this._injections.clear();
        this._settings.disconnectObject(this);
        this._button.menu.disconnectObject(this);

        // ANTES de destruir o botão: as páginas devolvem o que pegaram
        // emprestado do Shell (o calendário do GNOME).
        this._destroyPages();

        // destroy() tira o botão do painel, do statusArea e do gerenciador
        // de menus (o próprio Shell desfaz o que addToStatusArea fez).
        this._button.destroy();
        this._button = null;
        this._restoreDateMenu();
    }
}
