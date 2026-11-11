// SPDX-License-Identifier: GPL-3.0-or-later
// Todos os textos visíveis da ilha num lugar só.
//
// Por que um módulo separado? Para quem for traduzir (ou revisar o pt-BR)
// achar tudo de uma vez, sem caçar texto espalhado pelo código.
//
// Por que GETTERS (get calendar() {...}) e não constantes? Porque o gettext
// da extensão só passa a traduzir DEPOIS que o GNOME carrega a extensão e
// chama initTranslations(). Uma constante calculada quando o módulo é
// importado ficaria para sempre em inglês. Com getter, o _() roda na hora
// em que o texto é usado — já traduzido.
//
// Convenção do Luma Menu: o texto-fonte (msgid) é em inglês e a tradução
// fica em po/pt_BR.po. Na tela, tudo aparece em português do Brasil.

import GLib from 'gi://GLib';

import {
    gettext as _, pgettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

export const T = {
    // ----- Abas / páginas -----------------------------------------------------
    get music() {
        return _('Music');
    },
    get calendar() {
        return _('Calendar');
    },
    get notifications() {
        return _('Notifications');
    },
    get focus() {
        return pgettext('island page', 'Focus');
    },
    get reminders() {
        return _('Reminders');
    },

    // ----- Calendário ----------------------------------------------------------
    get today() {
        return _('Today');
    },
    get tomorrow() {
        return _('Tomorrow');
    },
    get yesterday() {
        return _('Yesterday');
    },
    get noEvents() {
        return _('No Events');
    },
    get allDay() {
        return pgettext('event time', 'All Day');
    },
    get worldClocks() {
        return _('World Clocks');
    },

    // ----- Acessibilidade ------------------------------------------------------
    get island() {
        return _('Island');
    },
};

/**
 * Formato da data na ilha fechada: "qua, 11 de nov".
 *
 * %a = dia da semana abreviado, %-d = dia sem zero à esquerda, %b = mês
 * abreviado — todos na língua do sistema (o GLib usa a locale pt_BR).
 *
 * @param {GLib.DateTime} dt
 * @returns {string}
 */
export function formatShortDate(dt) {
    /* Translators: date in the closed island, e.g. "Wed, Nov 11". Uses
     * GLib.DateTime.format() codes: %a weekday, %-d day, %b month. */
    return dt.format(_('%a, %b %-d'));
}

/**
 * Hora no formato escolhido em Configurações › Data e Hora (24 h ou AM/PM).
 *
 * @param {GLib.DateTime} dt
 * @param {boolean} use24h
 * @returns {string}
 */
export function formatTime(dt, use24h) {
    /* Translators: time in 24-hour format (GLib.DateTime.format codes). */
    const fmt24 = pgettext('time format', '%H:%M');
    /* Translators: time in 12-hour format (GLib.DateTime.format codes). */
    const fmt12 = pgettext('time format', '%-l:%M %p');
    return dt.format(use24h ? fmt24 : fmt12);
}

/**
 * Título do dia selecionado no calendário: "Hoje", "Amanhã", "Ontem" ou a
 * data completa ("qui, 12 de nov").
 *
 * @param {Date} day - meia-noite do dia
 * @returns {string}
 */
export function formatDayTitle(day) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / (24 * 3600 * 1000));
    if (diff === 0)
        return T.today;
    if (diff === 1)
        return T.tomorrow;
    if (diff === -1)
        return T.yesterday;
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(day.getTime() / 1000));
    if (day.getFullYear() === today.getFullYear())
        return formatShortDate(dt);
    /* Translators: a full date with year, e.g. "Wed, Nov 11, 2027". */
    return dt.format(_('%a, %b %-d, %Y'));
}

/**
 * Intervalo de um evento: "14:00 – 15:30" (ou só "14:00" se não tem fim).
 *
 * @param {Date} start
 * @param {Date} end
 * @param {boolean} use24h
 * @returns {string}
 */
export function formatTimeRange(start, end, use24h) {
    const a = formatTime(GLib.DateTime.new_from_unix_local(Math.floor(start / 1000)), use24h);
    if (!end || end.getTime() === start.getTime())
        return a;
    const b = formatTime(GLib.DateTime.new_from_unix_local(Math.floor(end / 1000)), use24h);
    return `${a} – ${b}`;
}
