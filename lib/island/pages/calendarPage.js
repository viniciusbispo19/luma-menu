// SPDX-License-Identifier: GPL-3.0-or-later
// Página Calendário da ilha: o mês ao lado dos eventos do dia selecionado.
//
// Não criamos um segundo calendário: EMPRESTAMOS o do GNOME (o mesmo widget
// que aparece ao clicar no relógio) enquanto a página está na tela, e o
// devolvemos ao fechar a ilha. Os eventos vêm da MESMA fonte que o relógio
// do GNOME usa (dateMenu._eventSource → org.gnome.Shell.CalendarServer →
// Evolution Data Server: Google, Nextcloud, contas online…).
//
// Por que emprestar em vez de criar um Calendar.Calendar novo? A classe do
// Shell conecta sinais do GSettings que ela nunca desconecta: um calendário
// novo a cada ativação da extensão seria um vazamento. E assim a semana, os
// feriados marcados e o estilo são exatamente os do GNOME (domingo primeiro
// em pt-BR, ou o que você escolheu nas Configurações).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {T, formatDayTitle, formatTimeRange} from '../strings.js';
import {logError} from '../../util.js';

/**
 * Tira um ator do lugar dele e o coloca em outro, lembrando de onde veio
 * para devolver na mesma posição.
 */
class Borrowed {
    /** @param {Clutter.Actor} actor */
    constructor(actor) {
        this.actor = actor;
        this._parent = actor.get_parent();
        this._index = this._parent?.get_children().indexOf(actor) ?? -1;
    }

    /** @param {St.Bin} slot */
    moveTo(slot) {
        this._parent?.remove_child(this.actor);
        slot.set_child(this.actor);
    }

    giveBack() {
        this.actor.get_parent()?.remove_child(this.actor);
        if (this._parent) {
            const index = Math.min(Math.max(this._index, 0), this._parent.get_n_children());
            this._parent.insert_child_at_index(this.actor, index);
        }
    }
}

export class CalendarPage {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this.id = 'calendar';
        this._settings = settings;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._calendar = null; // Borrowed
        this._clocks = null; // Borrowed
        this._eventSource = null;
        this._day = startOfDay(new Date());

        this.actor = new St.BoxLayout({style_class: 'luma-island-calendar'});

        this._calendarSlot = new St.Bin({style_class: 'luma-island-calendar-month'});
        this.actor.add_child(this._calendarSlot);

        const side = new St.BoxLayout({
            style_class: 'luma-island-events',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(side);

        this._title = new St.Label({style_class: 'luma-island-events-title'});
        side.add_child(this._title);

        this._list = new St.BoxLayout({
            style_class: 'luma-island-events-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'luma-island-events-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        side.add_child(this._scroll);

        this._clocksSlot = new St.Bin({
            style_class: 'luma-island-world-clocks',
            x_expand: true,
        });
        side.add_child(this._clocksSlot);

        // Rede de segurança: se a página for destruída com o calendário
        // emprestado dentro, o GNOME perderia o calendário dele. O sinal
        // "destroy" roda ANTES de os filhos serem destruídos, então dá tempo
        // de devolver.
        this.actor.connect('destroy', () => this.hide());
    }

    get title() {
        return T.calendar;
    }

    /** A página "viva" é escolhida ao abrir; o calendário nunca é. */
    get isLive() {
        return false;
    }

    /** A página vai aparecer: pega o calendário emprestado e carrega os eventos. */
    show() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        try {
            // _calendar, _clocksItem e _eventSource são internos do Shell
            // (conferidos no GNOME 51). Se sumirem numa versão futura, a
            // página continua funcionando só com a lista de eventos.
            if (!this._calendar && dateMenu?._calendar) {
                this._calendar = new Borrowed(dateMenu._calendar);
                this._calendar.moveTo(this._calendarSlot);
                this._calendar.actor.connectObject('selected-date-changed',
                    (_cal, datetime) => this._setDay(new Date(datetime.to_unix() * 1000)), this);
            }
            if (!this._clocks && dateMenu?._clocksItem && this._settings.get_boolean('island-world-clocks')) {
                this._clocks = new Borrowed(dateMenu._clocksItem);
                this._clocks.moveTo(this._clocksSlot);
            }
        } catch (e) {
            logError(e, 'emprestando o calendário do GNOME');
        }

        this._eventSource?.disconnectObject(this);
        this._eventSource = dateMenu?._eventSource ?? null;
        this._eventSource?.connectObject('changed', () => this._reload(), this);

        // Como o GNOME faz ao abrir o relógio: volta para hoje.
        const today = new Date();
        if (this._calendar)
            this._calendar.actor.setDate(today);
        this._setDay(today);
    }

    /** A ilha fechou: devolve tudo ao relógio do GNOME. */
    hide() {
        this._eventSource?.disconnectObject(this);
        this._eventSource = null;
        if (this._calendar) {
            this._calendar.actor.disconnectObject(this);
            this._calendar.giveBack();
            this._calendar = null;
        }
        this._clocks?.giveBack();
        this._clocks = null;
    }

    _setDay(date) {
        this._day = startOfDay(date);
        // Sem o calendário emprestado, nós mesmos pedimos o intervalo à fonte.
        if (!this._calendar) {
            const end = new Date(this._day);
            end.setDate(end.getDate() + 1);
            this._eventSource?.requestRange(this._day, end);
        }
        this._reload();
    }

    _reload() {
        this._title.text = formatDayTitle(this._day);
        this._list.destroy_all_children();

        const end = new Date(this._day);
        end.setDate(end.getDate() + 1);
        let events = [];
        try {
            if (this._eventSource && !this._eventSource.isLoading)
                events = this._eventSource.getEvents(this._day, end);
        } catch (e) {
            logError(e, 'lendo eventos');
        }

        const use24h = this._interface.get_string('clock-format') === '24h';
        for (const event of events) {
            const row = new St.BoxLayout({style_class: 'luma-island-event'});
            const allDay = event.date <= this._day && event.end >= end;
            row.add_child(new St.Label({
                style_class: 'luma-island-event-time',
                text: allDay ? T.allDay : formatTimeRange(event.date, event.end, use24h),
                y_align: Clutter.ActorAlign.START,
            }));
            const summary = new St.Label({
                style_class: 'luma-island-event-summary',
                text: event.summary ?? '',
                x_expand: true,
            });
            row.add_child(summary);
            this._list.add_child(row);
        }

        if (events.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'luma-island-placeholder',
                text: T.noEvents,
            }));
        }
    }

    destroy() {
        this.hide();
        this.actor.destroy();
    }
}

/**
 * @param {Date} date
 * @returns {Date} meia-noite do mesmo dia
 */
function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}
