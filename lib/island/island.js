// SPDX-License-Identifier: GPL-3.0-or-later
// As funções do Isle (github.com/zickrian/isle) adaptadas à barra do macOS.
//
// No Isle, tudo mora numa "ilha" preta no centro do topo da tela. Aqui a
// barra continua igual à do macOS (menus à esquerda, relógio no canto
// direito) e as funções do Isle moram no RELÓGIO:
//
//   - clicar no relógio abre um pop-up do GNOME (o mesmo "balão" dos menus
//     da barra) com as abas do Isle: Calendário, Notificações, Prateleira,
//     Foco, Lembretes e Uso; Esc ou clicar fora fecha, e com outro menu da barra aberto,
//     passar o mouse troca para este — o gerenciador de menus do painel faz
//     tudo isso;
//   - a temperatura fica ao lado do relógio, e os alertas (volume, brilho…)
//     saem de baixo dele.
//
// Este arquivo é o "controlador". Mudanças no Shell (todas desfeitas no
// destroy): esconde o relógio do GNOME (dateMenu) e faz o Super+V abrir a
// página Calendário. A barra preta fica no PanelLayout.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlertPresenter} from './alerts.js';
import {ClockButton} from './clockButton.js';
import {CalendarPage} from './pages/calendarPage.js';
import {FocusPage} from './pages/focusPage.js';
import {RemindersPage} from './pages/remindersPage.js';
import {ShelfPage} from './pages/shelfPage.js';
import {UsagePage} from './pages/usagePage.js';
import {EventReminders} from './services/eventReminders.js';
import {SystemAlerts} from './services/systemAlerts.js';
import {NotificationsPage} from './pages/notificationsPage.js';
import {NotificationStore} from './services/notifications.js';
import {OsdOverride} from './services/osdOverride.js';
import {WeatherService} from './services/weather.js';
import {T, formatCountdown, formatTemperature} from './strings.js';
import {VirtualKeyboard} from '../actions.js';
import {pasteAccelerator} from '../fallbackMenus.js';
import {TimeoutRegistry, debug, logError} from '../util.js';

/** Nome do nosso botão em Main.panel.statusArea. */
const STATUS_ROLE = 'luma-menu-clock';
/** A página escolhida à mão vale por 5 minutos (como no Isle). */
const PAGE_MEMORY = 5 * 60 * 1000 * 1000; // µs
/** Reconfere o alinhamento dos banners depois das outras extensões (ms). */
const BANNER_RECHECK_DELAY = 3000;
/** Troca de página: desliza e aparece (ms / px). */
const PAGE_SLIDE_TIME = 260;
const PAGE_SLIDE_OFFSET = 40;

// Se outra extensão mostrar o relógio do GNOME de novo, escondemos — no
// máximo 3 vezes a cada 10 s, para nunca virar uma "briga" infinita.
const MAX_REHIDE = 3;
const REHIDE_WINDOW = 10 * 1000 * 1000; // µs

/**
 * As páginas do pop-up. Cada uma recebe as configurações e o "contexto" da
 * ilha (serviços compartilhados e como fechar o pop-up).
 */
const PAGE_FACTORIES = {
    calendar: settings => new CalendarPage(settings),
    notifications: (settings, ctx) => new NotificationsPage(settings, ctx.notifications, ctx.closePopup),
    shelf: (settings, ctx) => new ShelfPage(settings, ctx),
    focus: (settings, ctx) => new FocusPage(settings, ctx.focus),
    reminders: (settings, ctx) => new RemindersPage(settings, ctx.reminders),
    usage: (settings, ctx) => new UsagePage(settings, ctx.usage),
};
/** Atalho que abre a Prateleira (o mesmo padrão do Copyous: Super+Shift+V). */
const CLIPBOARD_SHORTCUT = 'clipboard-shortcut';
/** Durante um arraste vindo de um app: de quanto em quanto olhar o ponteiro. */
const DRAG_CHECK_INTERVAL = 100; // ms

export class Island {
    /**
     * @param {Gio.Settings} settings
     * @param {BarLook} look - a cor da barra (os alertas usam a mesma)
     * @param {Function} getAppearance - () => aparência dos menus do Luma
     * @param {object} services - {focus, reminders, clipboard, fileTray,
     *   usage}: vivem na extensão (usage é null se o uso de apps está desligado)
     */
    constructor(settings, look, getAppearance, services) {
        this._settings = settings;
        this._getAppearance = getAppearance;
        this._injections = new InjectionManager();
        this._pages = [];
        this._currentPage = null;
        this._requestedPage = null;
        this._pickedPage = {id: null, time: 0};
        this._dateMenuHiddenByUs = false;
        this._rehides = [];

        // Notificações do GNOME (página Notificações + pontinho no relógio).
        this._notifications = new NotificationStore();
        this._focus = services.focus;
        this._keyboard = new VirtualKeyboard();
        this._ctx = {
            notifications: this._notifications,
            focus: services.focus,
            reminders: services.reminders,
            clipboard: services.clipboard,
            usage: services.usage,
            closePopup: () => this._button?.menu.close(),
            pasteItem: id => this._pasteItem(id),
            openTray: () => {
                this._button?.menu.close();
                services.fileTray.open();
            },
        };

        // ----- Relógio + pop-up -----
        this._button = new ClockButton(settings, getAppearance());
        this._fileTray = services.fileTray;
        const menu = this._button.menu;
        // O conteúdo do pop-up é um único "item" sem destaque, com as abas e
        // a página.
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: 'luma-island-panel',
            reactive: false,
            can_focus: false,
            activate: false,
        });
        item.add_child(this._buildContent());
        menu.addMenuItem(item);
        menu.beforeOpen = () => this._onBeforeOpen();
        // "menu-closed" chega DEPOIS da animação de fechar: só então a página
        // devolve o que pegou emprestado (o calendário do GNOME).
        menu.connectObject('menu-closed', () => this._onClosed(), this);
        this._buildPages();

        // Último item da caixa da direita: depois dos ícones de status, onde
        // fica o relógio no macOS. addToStatusArea também registra o menu no
        // gerenciador de menus do painel.
        Main.panel.addToStatusArea(STATUS_ROLE, this._button,
            Main.panel._rightBox.get_n_children(), 'right');

        // ----- Alertas (volume/brilho) saindo de baixo do relógio -----
        // Mensagens esperam o pop-up do relógio fechar (e saem da fila ao fechar).
        this._alerts = new AlertPresenter(settings, look, () => this._clockRect(),
            () => !menu.isOpen);
        menu.connectObject('open-state-changed', (_m, open) => {
            if (!open)
                this._alerts.flush();
        }, this);
        // Bateria fraca, Caps Lock, Bluetooth, rede; lembretes de eventos.
        this._systemAlerts = new SystemAlerts(settings, this._alerts);
        this._eventReminders = new EventReminders(settings, this._alerts);
        // Só com o pop-up fechado e sem tela cheia; senão, o OSD do GNOME.
        this._osd = new OsdOverride(settings, this._alerts, () =>
            !menu.isOpen && !Main.layoutManager.primaryMonitor?.inFullscreen);

        // ----- Temperatura ao lado do relógio -----
        this._weather = new WeatherService(settings);
        this._weather.connectObject('changed', () => this._syncWeather(), this);

        Main.layoutManager.connectObject('monitors-changed', () => this._syncGeometry(), this);
        Main.panel.connectObject('notify::height', () => this._syncGeometry(), this);
        settings.connectObject(
            'changed::menu-opacity', () => this._syncAppearance(),
            'changed::menu-radius', () => this._syncAppearance(),
            'changed::island-pages', () => this._rebuildPages(),
            this);
        look.connectObject('changed', () => this._syncAppearance(), this);
        this._look = look;

        this._hideDateMenu();
        // Banners de notificação no CANTO DIREITO, embaixo do relógio (como no
        // macOS). É a mesma propriedade que o GNOME usa para pôr os banners do
        // lado do relógio dele — que está escondido. Com o banner desse lado, o
        // painel também o segura enquanto o pop-up do relógio está aberto.
        this._originalBannerAlignment = Main.messageTray.bannerAlignment;
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        // O painel do GNOME redefine o alinhamento a cada mudança de modo de
        // sessão (ui/panel.js, _updatePanel), pela posição do relógio DELE.
        // Ele se conectou antes de nós, então este handler roda depois e
        // reaplica o nosso.
        Main.sessionMode.connectObject('updated', () => {
            this._originalBannerAlignment = Main.messageTray.bannerAlignment;
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        }, this);
        // O Just Perfection também tem uma opção de posição dos banners e a
        // aplica quando é ativado (depois de nós). Conferimos UMA vez, 3 s
        // depois, quando as extensões já terminaram de iniciar — sem "brigar"
        // se você mudar a opção dele depois.
        this._timers = new TimeoutRegistry();
        this._timers.add(BANNER_RECHECK_DELAY, () => {
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        });
        // Super+V abre a página Calendário (o relógio do GNOME está escondido).
        const island = this;
        this._injections.overrideMethod(Main.panel, 'toggleCalendar', () => function() {
            island.toggle('calendar');
        });
        // Super+Shift+V abre a Prateleira já com o cursor na busca.
        Main.wm.addKeybinding(CLIPBOARD_SHORTCUT, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle('shelf', true));

        this._notifications.connectObject('changed', () => this._syncUnseen(), this);

        // Arrastou um arquivo de um app até o relógio: abre a bandeja.
        // No Wayland o Shell fica sabendo que um arraste começou e terminou,
        // mas NÃO recebe a posição dele. Então, só enquanto há um arraste,
        // olhamos onde o ponteiro está (a cada 100 ms); fora disso, nada roda.
        this._dragCheckId = 0;
        Main.xdndHandler.connectObject(
            'drag-begin', () => this._watchDrag(true),
            'drag-end', () => this._watchDrag(false),
            this);

        // Timer de foco: fim de fase vira alerta; ao lado do relógio, o tempo
        // restante (tique de 1 s só enquanto roda).
        this._focusTick = 0;
        this._focus.connectObject(
            'changed', () => this._syncFocusActivity(),
            'phase-ended', (_t, phase) => this._onFocusPhaseEnded(phase),
            this);
        this._syncFocusActivity();

        this._syncGeometry();
        this._syncWeather();
        this._syncUnseen();
    }

    _syncFocusActivity() {
        const f = this._focus;
        const active = f.status !== 'idle';
        this._button.setFocusActivity(active ? formatCountdown(f.remaining) : null,
            f.status === 'paused', f.phase);
        if (f.status === 'running' && !this._focusTick) {
            this._focusTick = this._timers.add(1000, () => this._focusTickFired());
        } else if (f.status !== 'running' && this._focusTick) {
            this._timers.remove(this._focusTick);
            this._focusTick = 0;
        }
    }

    _focusTickFired() {
        this._focusTick = 0;
        this._syncFocusActivity();
    }

    _onFocusPhaseEnded(phase) {
        const work = phase === 'work';
        this._alerts.showMessage({
            key: `focus-${phase}-${Date.now()}`,
            iconName: 'alarm-symbolic',
            title: work ? T.focusDone : T.breakDone,
            subtitle: work ? T.focusDoneHint : T.breakDoneHint,
            actionLabel: work ? T.startBreak : T.startFocus,
            onAction: () => this._focus.start(),
            duration: 8000,
        });
    }

    /** Pontinho ao lado do relógio: há notificações que você não viu. */
    _syncUnseen() {
        this._button.setUnseen(!this._notifications.doNotDisturb &&
            this._notifications.unseenCount > 0);
    }

    // ----- Construção ---------------------------------------------------------------

    /**
     * Conteúdo do pop-up:
     *
     *   [Música] [Calendário] …            ☁ 28° Parcialmente nublado
     *   ──────────────────────────────────────────────────────────────
     *   página
     */
    _buildContent() {
        const content = new St.BoxLayout({
            style_class: 'luma-island-content',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const header = new St.BoxLayout({style_class: 'luma-island-header'});
        content.add_child(header);

        this._tabs = new St.BoxLayout({
            style_class: 'luma-island-tabs',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._tabs);

        // O tempo agora, por extenso (a barra só mostra o ícone e os graus).
        this._weatherSummary = new St.BoxLayout({
            style_class: 'luma-island-weather',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._summaryIcon = new St.Icon({
            style_class: 'luma-island-weather-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._summaryTemp = new St.Label({
            style_class: 'luma-island-weather-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._summaryCondition = new St.Label({
            style_class: 'luma-island-weather-condition',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._weatherSummary.add_child(this._summaryIcon);
        this._weatherSummary.add_child(this._summaryTemp);
        this._weatherSummary.add_child(this._summaryCondition);
        header.add_child(this._weatherSummary);

        this._stack = new St.Widget({
            style_class: 'luma-island-page',
            layout_manager: new Clutter.BinLayout(),
        });
        content.add_child(this._stack);
        return content;
    }

    _buildPages() {
        const ids = this._settings.get_strv('island-pages');
        // A página Uso aparece quando o uso de apps está ligado (por último).
        if (this._ctx.usage)
            ids.push('usage');
        for (const id of ids) {
            const factory = PAGE_FACTORIES[id];
            if (!factory || this._pages.some(p => p.id === id))
                continue;
            try {
                const page = factory(this._settings, this._ctx);
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
     * Super+V: abre o pop-up na página pedida; se ela já está aberta, fecha.
     *
     * @param {string} pageId
     * @param {boolean} [focusSearch] - começar digitando na busca (Prateleira)
     */
    toggle(pageId, focusSearch = false) {
        const menu = this._button.menu;
        const entry = this._pages.find(p => p.id === pageId) ?? null;
        if (focusSearch && !entry)
            return; // página desligada nas preferências
        if (menu.isOpen) {
            if (entry && this._currentPage !== entry)
                this._showPage(entry, true);
            else
                menu.close();
        } else {
            this._requestedPage = entry;
            menu.open();
        }
        // O gerenciador de menus põe o foco no pop-up ao abrir; a busca pega
        // o foco logo DEPOIS disso.
        if (focusSearch && menu.isOpen) {
            this._timers.add(0, () => {
                if (this._currentPage === entry)
                    entry.page.focusSearch?.();
            });
        }
    }

    _watchDrag(dragging) {
        if (this._dragCheckId) {
            GLib.source_remove(this._dragCheckId);
            this._dragCheckId = 0;
        }
        if (!dragging)
            return;
        this._dragCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_CHECK_INTERVAL, () => {
            const [x, y] = global.get_pointer();
            const clock = this._clockRect();
            const panelBottom = Main.panel.get_transformed_position()[1] + Main.panel.height;
            if (!clock || y > panelBottom || x < clock.x || x > clock.x + clock.width)
                return GLib.SOURCE_CONTINUE;
            this._dragCheckId = 0;
            this._fileTray.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Liga/desliga a página Uso (o serviço vive na extensão). */
    setUsage(usage) {
        this._ctx.usage = usage;
        this._rebuildPages();
    }

    /**
     * Prateleira: põe o item de volta na área de transferência, fecha o
     * pop-up e (opção ligada) cola direto no app — com Ctrl+V, ou
     * Ctrl+Shift+V nos terminais.
     *
     * @param {string} id
     */
    async _pasteItem(id) {
        // A janela em foco é a do app (o pop-up não tira o foco dela).
        const window = global.display.focus_window;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        let copied = false;
        try {
            copied = await this._ctx.clipboard.copy(id);
        } catch (e) {
            logError(e, 'copiando do histórico');
        }
        this._button?.menu.close();
        if (!copied || !window || !this._settings.get_boolean('clipboard-paste-on-select'))
            return;
        const accel = pasteAccelerator(app, window);
        if (accel)
            this._keyboard.send(accel);
    }

    _onBeforeOpen() {
        const entry = this._requestedPage ?? this._choosePage();
        this._requestedPage = null;
        // Um alerta embaixo do relógio dá lugar ao pop-up.
        this._alerts.dismiss();
        if (entry) {
            debug('relógio: abrindo na página', entry.id);
            this._showPage(entry, false);
        }
    }

    /** O pop-up terminou de fechar: a página devolve o que foi emprestado. */
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

    // ----- Clima, geometria e aparência -------------------------------------------

    /** Temperatura no relógio e, no pop-up, também a condição por extenso. */
    _syncWeather() {
        const value = this._weather.value;
        const text = value ? formatTemperature(value.celsius, this._weather.unit) : '';
        this._button.setWeather(value, text);

        this._weatherSummary.visible = Boolean(value);
        if (!value)
            return;
        this._summaryIcon.icon_name = value.icon;
        this._summaryTemp.text = text;
        this._summaryCondition.text = value.condition ?? '';
        this._weatherSummary.opacity = value.stale ? 150 : 255;
    }

    _syncGeometry() {
        const barHeight = Math.max(Main.panel.height, 24);
        this._alerts.setGeometry(barHeight, Main.layoutManager.primaryMonitor,
            Main.layoutManager.primaryIndex);
    }

    _syncAppearance() {
        this._button.menu.setAppearance(this._getAppearance());
    }

    /** @returns {{x: number, width: number}|null} o relógio na tela agora */
    _clockRect() {
        if (!this._button.has_allocation())
            return null;
        const [x] = this._button.get_transformed_position();
        const [width] = this._button.get_transformed_size();
        if (!Number.isFinite(x) || !Number.isFinite(width))
            return null;
        return {x: Math.round(x), width: Math.round(width)};
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
        Main.wm.removeKeybinding(CLIPBOARD_SHORTCUT);
        this._keyboard.destroy();
        this._timers.clear();
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._look.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        this._button.menu.disconnectObject(this);

        this._focus.disconnectObject(this);
        Main.xdndHandler.disconnectObject(this);
        this._watchDrag(false);
        this._systemAlerts.destroy();
        this._eventReminders.destroy();
        this._osd.destroy();
        this._alerts.destroy();
        this._weather.disconnectObject(this);
        this._weather.destroy();
        this._notifications.disconnectObject(this);

        // ANTES de destruir o botão (e o pop-up junto): as páginas devolvem o
        // que pegaram emprestado do Shell (o calendário do GNOME).
        this._destroyPages();

        // destroy() tira o botão do painel, do statusArea e do gerenciador de
        // menus (o próprio Shell desfaz o que addToStatusArea fez).
        this._button.destroy();
        this._button = null;
        this._notifications.destroy();
        this._restoreDateMenu();
        Main.messageTray.bannerAlignment = this._originalBannerAlignment;
    }
}
