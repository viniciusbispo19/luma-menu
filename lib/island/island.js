// SPDX-License-Identifier: GPL-3.0-or-later
// As funções do Isle (github.com/zickrian/isle) adaptadas à barra do macOS.
//
// No Isle, tudo mora numa "ilha" preta no centro do topo da tela. Aqui a
// barra continua igual à do macOS (menus à esquerda, relógio no canto
// direito), toda em preto sólido, e a ilha nasce do RELÓGIO:
//
//   - clicar no relógio faz uma forma preta "sair" da barra embaixo dele,
//     crescendo com uma mola, com as abas do Isle (Música, Calendário,
//     Notificações, Foco, Lembretes);
//   - Esc, clicar fora ou clicar de novo no relógio fecha (a forma volta
//     para dentro do relógio);
//   - as "atividades vivas" (música, timer) aparecem ao lado do relógio, e os
//     alertas saem do mesmo lugar (próximas fases).
//
// Este arquivo é o "controlador". Mudanças no Shell (todas desfeitas no
// destroy): esconde o relógio do GNOME (dateMenu) e faz o Super+V abrir a
// página Calendário. A barra preta fica no PanelLayout.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {GrabHelper} from 'resource:///org/gnome/shell/ui/grabHelper.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClockButton} from './clockButton.js';
import {IslandShape} from './islandShape.js';
import {CalendarPage} from './pages/calendarPage.js';
import {debug, logError} from '../util.js';

/** Nome do nosso botão em Main.panel.statusArea. */
const STATUS_ROLE = 'luma-menu-clock';
/** A página escolhida à mão vale por 5 minutos (como no Isle). */
const PAGE_MEMORY = 5 * 60 * 1000 * 1000; // µs
/** Troca de página: desliza e aparece (ms / px). */
const PAGE_SLIDE_TIME = 260;
const PAGE_SLIDE_OFFSET = 40;

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
        this._grabbed = false;

        // ----- Relógio na barra -----
        this._button = new ClockButton(settings);
        // Último item da caixa da direita: depois dos ícones de status, onde
        // fica o relógio no macOS.
        Main.panel.addToStatusArea(STATUS_ROLE, this._button,
            Main.panel._rightBox.get_n_children(), 'right');
        this._button.connectObject(
            'island-toggle', () => this.toggle(),
            // O relógio mudou de largura/lugar (data ligada, 9:59 → 10:00):
            // a forma fechada acompanha.
            'notify::allocation', () => this._syncAnchor(),
            this);

        // ----- Forma do Isle -----
        this._shape = new IslandShape();
        this._shape.setContent(this._buildContent(), [this._tabs, this._stack]);
        this._shape.connectObject('closed', () => this._onClosed(), this);
        Main.layoutManager.addChrome(this._shape);
        // GrabHelper: enquanto aberta, a forma fica com o teclado e o mouse;
        // Esc ou clique fora "soltam" e chamam onUngrab (fechamos).
        this._grabHelper = new GrabHelper(this._shape);
        this._buildPages();

        Main.layoutManager.connectObject('monitors-changed', () => this._syncGeometry(), this);
        Main.panel.connectObject(
            'notify::height', () => this._syncGeometry(),
            'style-changed', () => this._syncHeaderFont(),
            this);
        settings.connectObject('changed::island-pages', () => this._rebuildPages(), this);

        this._hideDateMenu();
        // Super+V abre a página Calendário (o relógio do GNOME está escondido).
        const island = this;
        this._injections.overrideMethod(Main.panel, 'toggleCalendar', () => function() {
            island.toggle('calendar');
        });

        this._syncGeometry();
        this._syncHeaderFont();
    }

    // ----- Construção ---------------------------------------------------------------

    /**
     * Conteúdo da forma aberta:
     *
     *   ┌ cabeçalho (altura da barra) ─────────────────────────────┐
     *   │ [Música] [Calendário] …                 qua, 11 de nov 14:05 │
     *   ├──────────────────────────────────────────────────────────┤
     *   │ página                                                   │
     *   └──────────────────────────────────────────────────────────┘
     *
     * A data/hora do cabeçalho é uma cópia do relógio, no MESMO lugar: a
     * forma cobre o relógio e ele "continua lá".
     */
    _buildContent() {
        const content = new St.BoxLayout({
            style_class: 'luma-island-content',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._header = new St.BoxLayout({style_class: 'luma-island-header'});
        content.add_child(this._header);

        this._tabs = new St.BoxLayout({
            style_class: 'luma-island-tabs',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._tabs);

        // Clicar na hora (que está por cima do relógio) fecha, como clicar
        // de novo no relógio.
        this._headerClock = new St.Button({
            style_class: 'luma-island-header-clock',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: false,
        });
        const clockBox = new St.BoxLayout({style_class: 'luma-island-clock-box'});
        this._headerClock.set_child(clockBox);
        for (const source of [this._button.dateLabel, this._button.timeLabel]) {
            const label = new St.Label({
                style_class: source.style_class,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            source.bind_property('text', label, 'text', GObject.BindingFlags.SYNC_CREATE);
            source.bind_property('visible', label, 'visible', GObject.BindingFlags.SYNC_CREATE);
            clockBox.add_child(label);
        }
        this._headerClock.connect('clicked', () => this.close());
        this._header.add_child(this._headerClock);

        this._stack = new St.Widget({
            style_class: 'luma-island-page',
            layout_manager: new Clutter.BinLayout(),
        });
        content.add_child(this._stack);
        return content;
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
                const entry = {id, page, tab};
                tab.connect('clicked', () => {
                    this._pickedPage = {id, time: GLib.get_monotonic_time()};
                    this._showPage(entry, true);
                });
                this._tabs.add_child(tab);
                this._pages.push(entry);
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
        this._hideCurrentPage();
        for (const {page, tab} of this._pages) {
            page.destroy();
            tab.destroy();
        }
        this._pages = [];
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    /**
     * Clique no relógio: abre (ou fecha). Com `pageId` (Super+V), abre nessa
     * página — e se ela já está aberta, fecha.
     *
     * @param {string} [pageId]
     */
    toggle(pageId = null) {
        const entry = pageId ? this._pages.find(p => p.id === pageId) : null;
        if (this._shape.isOpen) {
            if (entry && this._currentPage !== entry)
                this._showPage(entry, true);
            else
                this.close();
            return;
        }
        this.open(entry);
    }

    /** @param {object} [entry] - página pedida (senão, escolhe sozinha) */
    open(entry = null) {
        entry ??= this._choosePage();
        if (!entry || this._shape.isOpen)
            return;
        debug('relógio: abrindo na página', entry.id);
        this._syncAnchor();
        this._showPage(entry, false);
        this._shape.open();
        this._grabbed = Boolean(this._grabHelper.grab({
            actor: this._shape,
            onUngrab: () => {
                this._grabbed = false;
                this.close();
            },
        }));
    }

    close() {
        if (!this._shape.isOpen)
            return;
        if (this._grabbed) {
            this._grabbed = false;
            this._grabHelper.ungrab({actor: this._shape});
        }
        this._shape.close();
    }

    /** A forma terminou de voltar para o relógio: devolve o que foi emprestado. */
    _onClosed() {
        if (!this._shape.isOpen)
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

        // Desliza a partir do lado da aba anterior (Isle: 48 px, 260 ms).
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
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
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

    // ----- Geometria e estilo -----------------------------------------------------

    _syncGeometry() {
        const barHeight = Math.max(Main.panel.height, 24);
        this._header.style = `height: ${barHeight}px;`;
        this._shape.setGeometry(Main.layoutManager.primaryMonitor, barHeight);
        this._syncAnchor();
    }

    /** A forma nasce do relógio: guardamos onde ele está na tela. */
    _syncAnchor() {
        if (!this._button.has_allocation())
            return;
        const [x] = this._button.get_transformed_position();
        const [width] = this._button.get_transformed_size();
        this._shape.setAnchor(Math.round(x), Math.round(width));
        // A hora do cabeçalho fica exatamente sobre a do relógio: mesma
        // margem que o botão do painel usa (-natural-hpadding, lida pelo
        // PanelMenu.ButtonBox do Shell).
        const pad = this._button.get_theme_node().get_length('-natural-hpadding');
        this._headerClock.style = `padding-right: ${Math.round(pad)}px;`;
    }

    /**
     * O cabeçalho imita o texto da barra (fonte e tamanho do tema), já que a
     * forma não é filha do painel e não herdaria esse estilo sozinha.
     */
    _syncHeaderFont() {
        try {
            const font = Main.panel.get_theme_node().get_font();
            const rules = [];
            if (font.get_family())
                rules.push(`font-family: "${font.get_family()}"`);
            if (font.get_size() > 0) {
                // O tamanho vem em px ou pt, conforme o tema (WhiteSur: px).
                const unit = font.get_size_is_absolute() ? 'px' : 'pt';
                rules.push(`font-size: ${font.get_size() / Pango.SCALE}${unit}`);
            }
            this._shape.style = rules.length ? `${rules.join('; ')};` : null;
        } catch (e) {
            logError(e, 'lendo a fonte da barra');
        }
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
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._button.disconnectObject(this);
        this._shape.disconnectObject(this);

        if (this._grabbed) {
            this._grabbed = false;
            this._grabHelper.ungrab({actor: this._shape});
        }

        // ANTES de destruir a forma: as páginas devolvem o que pegaram
        // emprestado do Shell (o calendário do GNOME).
        this._destroyPages();

        this._shape.stopAnimations();
        Main.layoutManager.removeChrome(this._shape);
        this._shape.destroy();
        this._shape = null;

        // destroy() tira o botão do painel e do statusArea.
        this._button.destroy();
        this._button = null;
        this._restoreDateMenu();
    }
}
