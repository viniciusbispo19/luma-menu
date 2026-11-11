// SPDX-License-Identifier: GPL-3.0-or-later
// A ilha (notch) no centro do topo da tela, no lugar do relógio do GNOME.
//
// Este arquivo é o "controlador": cria a ilha, decide quando abrir e fechar,
// qual página mostrar, e faz (e DESFAZ no destroy) as mudanças no Shell:
//
//   1. esconde o relógio do GNOME (dateMenu) e põe um "reservador" do mesmo
//      tamanho da ilha fechada no centro do painel — assim o painel e a barra
//      de menus (que transborda até o primeiro item do centro) enxergam o
//      espaço que a ilha ocupa;
//   2. a ilha em si é um ator de "chrome" (Main.layoutManager.addChrome):
//      fica por cima do painel e das janelas, recebe o mouse, e o próprio
//      Shell a esconde quando há uma janela em tela cheia;
//   3. Super+V (atalho do GNOME para o calendário) passa a abrir a página
//      Calendário da ilha;
//   4. Esc fecha a ilha — mas o atalho só existe ENQUANTO ela está aberta,
//      para não roubar o Esc dos aplicativos quando você só passa o mouse.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClosedView} from './closedView.js';
import {IslandActor} from './islandActor.js';
import {CalendarPage} from './pages/calendarPage.js';
import {TimeoutRegistry, debug, logError} from '../util.js';

/** Tempo de tolerância depois que o ponteiro sai da ilha aberta (ms). */
const CLOSE_DELAY = 300;
/** A página escolhida à mão vale por 5 minutos. */
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
        this._timers = new TimeoutRegistry();
        this._openTimer = 0;
        this._closeTimer = 0;
        this._injections = new InjectionManager();
        this._pages = [];
        this._currentPage = null;
        this._pickedPage = {id: null, time: 0};
        this._escBound = false;
        this._dateMenuHiddenByUs = false;
        this._rehides = [];

        // ----- Atores -----
        this._actor = new IslandActor();
        this._closedView = new ClosedView(settings);
        this._openView = this._buildOpenView();
        this._actor.setViews(this._closedView, this._openView);
        this._buildPages();

        // trackFullscreen: o Shell esconde a ilha sobre janelas em tela cheia.
        // (No GNOME 51 não existe mais "affectsInputRegion": todo chrome
        // recebe o mouse na área que ocupa.)
        Main.layoutManager.addChrome(this._actor, {trackFullscreen: true});

        this._spacer = new St.Widget({name: 'lumaMenuIslandSpacer'});
        Main.panel._centerBox.insert_child_at_index(this._spacer, 0);

        // ----- Sinais -----
        this._actor.connectObject(
            'notify::hover', () => this._onHoverChanged(),
            'closed', () => this._onClosed(),
            'closed-width-changed', () => this._syncSpacer(),
            this);
        this._closedView.connectObject('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_PRIMARY)
                this.open();
        }, this);

        Main.layoutManager.connectObject('monitors-changed', () => this._syncGeometry(), this);
        Main.panel.connectObject(
            'notify::height', () => this._syncGeometry(),
            'style-changed', () => this._syncClosedStyle(),
            this);
        settings.connectObject(
            'changed::menu-opacity', () => this._syncAppearance(),
            'changed::menu-radius', () => this._syncAppearance(),
            'changed::island-pages', () => this._rebuildPages(),
            this);

        this._hideDateMenu();
        // Super+V abre a página Calendário da ilha (o menu do relógio do
        // GNOME está escondido). Restaurado no destroy().
        const island = this;
        this._injections.overrideMethod(Main.panel, 'toggleCalendar', () => function() {
            island.toggle('calendar');
        });

        this._syncAppearance();
        this._syncGeometry();
        this._syncClosedStyle();
        this._syncSpacer();
    }

    // ----- Construção ---------------------------------------------------------------

    _buildOpenView() {
        const view = new St.BoxLayout({
            style_class: 'luma-island-open',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._header = new St.BoxLayout({style_class: 'luma-island-header'});
        view.add_child(this._header);

        this._tabs = new St.BoxLayout({
            style_class: 'luma-island-tabs',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._tabs);

        this._stack = new St.Widget({
            style_class: 'luma-island-page',
            layout_manager: new Clutter.BinLayout(),
        });
        view.add_child(this._stack);
        return view;
    }

    _buildPages() {
        const wanted = this._settings.get_strv('island-pages');
        for (const id of wanted) {
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
                    this._showPage(page, true);
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
        this.close();
        this._destroyPages();
        this._buildPages();
    }

    _destroyPages() {
        // Primeiro escondemos (a página Calendário devolve o calendário do
        // GNOME), depois destruímos.
        this._currentPage?.page.hide();
        this._currentPage = null;
        for (const {page, tab} of this._pages) {
            page.destroy();
            tab.destroy();
        }
        this._pages = [];
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    /**
     * @param {string} [pageId] - abre nesta página (senão, escolhe sozinha)
     */
    open(pageId = null) {
        this._timers.remove(this._openTimer);
        this._timers.remove(this._closeTimer);
        const entry = this._pages.find(p => p.id === pageId) ?? this._choosePage();
        if (!entry)
            return;
        this._showPage(entry, this._actor.isOpen);
        if (!this._actor.isOpen) {
            debug('ilha: abrindo na página', entry.id);
            this._actor.open();
            this._bindEsc(true);
        }
    }

    close() {
        this._timers.remove(this._openTimer);
        this._timers.remove(this._closeTimer);
        if (!this._actor.isOpen)
            return;
        this._bindEsc(false);
        this._actor.close();
    }

    /**
     * Abre na página pedida; se ela já está aberta, fecha (Super+V).
     *
     * @param {string} pageId
     */
    toggle(pageId) {
        if (this._actor.isOpen && this._currentPage?.id === pageId)
            this.close();
        else
            this.open(pageId);
    }

    /**
     * Página ao abrir: a escolhida à mão nos últimos 5 minutos; senão uma
     * página "viva" (música tocando, timer rodando, notificações não vistas);
     * senão a primeira da lista.
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
        if (this._currentPage === entry)
            return;
        const old = this._currentPage;
        const oldIndex = old ? this._pages.indexOf(old) : -1;
        if (old) {
            old.page.hide();
            this._stack.remove_child(old.page.actor);
        }
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

    _syncTabs() {
        for (const entry of this._pages) {
            if (entry === this._currentPage)
                entry.tab.add_style_pseudo_class('checked');
            else
                entry.tab.remove_style_pseudo_class('checked');
        }
    }

    /** A ilha terminou de fechar: a página devolve o que pegou emprestado. */
    _onClosed() {
        if (this._actor.isOpen || !this._currentPage)
            return;
        this._currentPage.page.hide();
        this._stack.remove_child(this._currentPage.page.actor);
        this._currentPage = null;
        this._syncTabs();
    }

    // ----- Ponteiro ---------------------------------------------------------------

    _onHoverChanged() {
        if (this._actor.hover) {
            this._timers.remove(this._closeTimer);
            this._closeTimer = 0;
            const delay = this._settings.get_int('island-hover-delay');
            // Passar o mouse rápido por cima não abre: é preciso PARAR sobre
            // a ilha pelo tempo configurado (0 = só com clique).
            if (!this._actor.isOpen && delay > 0 && !this._openTimer) {
                this._openTimer = this._timers.add(delay, () => {
                    this._openTimer = 0;
                    this.open();
                });
            }
        } else {
            this._timers.remove(this._openTimer);
            this._openTimer = 0;
            if (this._actor.isOpen && !this._closeTimer) {
                this._closeTimer = this._timers.add(CLOSE_DELAY, () => {
                    this._closeTimer = 0;
                    this.close();
                });
            }
        }
    }

    _bindEsc(bind) {
        if (bind && !this._escBound) {
            Main.wm.addKeybinding('island-close-shortcut', this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this.close());
            this._escBound = true;
        } else if (!bind && this._escBound) {
            Main.wm.removeKeybinding('island-close-shortcut');
            this._escBound = false;
        }
    }

    // ----- Painel e aparência -----------------------------------------------------

    _syncGeometry() {
        this._actor.setMonitor(Main.layoutManager.primaryMonitor);
        // A ilha fechada tem a altura do painel (WhiteSur: 28 px), e as abas
        // da ilha aberta ficam nessa mesma faixa.
        const height = Math.max(Main.panel.height, 24);
        this._actor.setClosedHeight(height);
        this._header.style = `height: ${height}px;`;
    }

    /**
     * A ilha fechada imita o relógio do painel: mesma cor, fonte, tamanho e
     * peso que o tema (WhiteSur) dá ao texto da barra. Ela não é filha do
     * painel (é chrome no uiGroup), então não herdaria esse estilo sozinha.
     */
    _syncClosedStyle() {
        try {
            const node = Main.panel.get_theme_node();
            const fg = node.get_foreground_color();
            const font = node.get_font();
            const rules = [`color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${(fg.alpha / 255).toFixed(3)})`];
            if (font.get_family())
                rules.push(`font-family: "${font.get_family()}"`);
            // O tamanho pode vir em pontos ou em pixels ("absoluto"),
            // conforme o tema o declarou (o WhiteSur usa px).
            if (font.get_size() > 0) {
                const unit = font.get_size_is_absolute() ? 'px' : 'pt';
                rules.push(`font-size: ${font.get_size() / Pango.SCALE}${unit}`);
            }
            rules.push(`font-weight: ${font.get_weight()}`);
            this._closedView.style = `${rules.join('; ')};`;
        } catch (e) {
            logError(e, 'lendo o estilo do painel');
        }
    }

    _syncSpacer() {
        this._spacer.width = this._actor.closedWidth;
    }

    _syncAppearance() {
        this._actor.setAppearance({
            opacity: this._settings.get_int('menu-opacity') / 100,
            radius: this._settings.get_int('menu-radius'),
        });
    }

    _hideDateMenu() {
        const container = Main.panel.statusArea.dateMenu?.container;
        if (!container)
            return;
        if (container.visible) {
            container.hide();
            this._dateMenuHiddenByUs = true;
        }
        // Se alguém mostrar o relógio de novo (ex.: outra extensão sendo
        // desativada), escondemos — com limite contra "brigas".
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
        this._timers.clear();
        this._bindEsc(false);
        this._injections.clear();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._actor.disconnectObject(this);
        this._closedView.disconnectObject(this);

        // ANTES de destruir a ilha: as páginas devolvem o que pegaram
        // emprestado do Shell (o calendário do GNOME).
        this._currentPage?.page.actor.remove_all_transitions();
        this._destroyPages();

        this._actor.stopAnimations();
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._spacer.destroy();
        this._restoreDateMenu();
    }
}
