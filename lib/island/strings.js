// SPDX-License-Identifier: GPL-3.0-or-later
// Todos os textos visíveis do relógio e do painel do Isle num lugar só.
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
    gettext as _, ngettext, pgettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

export const T = {
    // ----- Abas / páginas -----------------------------------------------------
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

    // ----- Notificações ----------------------------------------------------------
    get noNotifications() {
        return _('No Notifications');
    },
    get clear() {
        return _('Clear');
    },
    get doNotDisturb() {
        return _('Do Not Disturb');
    },
    get close() {
        return _('Close');
    },
    get doNotDisturbOn() {
        return _('Only urgent notifications appear while Do Not Disturb is on');
    },

    // ----- Foco ---------------------------------------------------------------------
    get focusBreak() {
        return pgettext('focus phase', 'Break');
    },
    get start() {
        return _('Start');
    },
    get pause() {
        return _('Pause');
    },
    get resume() {
        return _('Resume');
    },
    get reset() {
        return _('Reset');
    },
    get focusDone() {
        return _('Focus session done');
    },
    get focusDoneHint() {
        return _('Time for a break');
    },
    get startBreak() {
        return _('Start Break');
    },
    get breakDone() {
        return _('Break is over');
    },
    get breakDoneHint() {
        return _('Ready to focus again?');
    },
    get startFocus() {
        return _('Start Focus');
    },

    // ----- Lembretes -------------------------------------------------------------
    get newReminder() {
        return _('New reminder…');
    },
    get noReminders() {
        return _('No reminders');
    },
    get done() {
        return _('Done');
    },

    // ----- Alertas do sistema ------------------------------------------------------
    get lowBattery() {
        return _('Low Battery');
    },
    get batteryCharged() {
        return _('Battery Charged');
    },
    get capsLockOn() {
        return _('Caps Lock On');
    },
    get capsLockOff() {
        return _('Caps Lock Off');
    },
    get connected() {
        return _('Connected');
    },
    get disconnected() {
        return _('Disconnected');
    },
    get offline() {
        return _('Offline');
    },
    get offlineHint() {
        return _('The network connection was lost');
    },
    get backOnline() {
        return _('Back Online');
    },
    get join() {
        return _('Join');
    },

    // ----- Alertas de volume e brilho -------------------------------------------
    get volume() {
        return _('Volume');
    },
    get brightness() {
        return _('Brightness');
    },
    get keyboardBrightness() {
        return _('Keyboard Brightness');
    },
    get muted() {
        return _('Muted');
    },

    // ----- Bateria ----------------------------------------------------------------
    get battery() {
        return _('Battery');
    },
    get charging() {
        return _('Charging');
    },
    get charged() {
        return _('Charged');
    },
    get pluggedIn() {
        return _('Plugged In');
    },
    get powerSaver() {
        return _('Power Saver');
    },

    // ----- Prateleira (área de transferência) ------------------------------------
    get shelf() {
        return _('Shelf');
    },
    get searchClipboard() {
        return _('Search copied items…');
    },
    get pauseHistory() {
        return _('Pause history');
    },
    get resumeHistory() {
        return _('Resume history');
    },
    get historyPaused() {
        return _('Paused: nothing new is saved');
    },
    get clearUnpinned() {
        return _('Clear (keeps pinned items)');
    },
    get nothingCopied() {
        return _('Nothing copied yet');
    },
    get noMatches() {
        return _('Nothing found');
    },
    get pin() {
        return _('Pin');
    },
    get unpin() {
        return _('Unpin');
    },
    get remove() {
        return _('Remove');
    },
    get image() {
        return _('Image');
    },
    get link() {
        return _('Link');
    },
    get fileTray() {
        return _('File Tray');
    },
    get fileTrayHint() {
        return _('Drag files onto the clock to keep them at hand');
    },

    // ----- Uso de apps ------------------------------------------------------------
    get usage() {
        return _('Usage');
    },
    get lastSevenDays() {
        return _('7 days');
    },
    get noUsageYet() {
        return _('Nothing recorded yet');
    },
    get clearUsage() {
        return _('Clear history');
    },
    get usageTotal() {
        /* Translators: {time} is a duration, e.g. "5 h 12 min". */
        return _('Total: {time}');
    },
};

/**
 * Formato da data no relógio da barra: "qua, 11 de nov".
 *
 * %a = dia da semana abreviado, %-d = dia sem zero à esquerda, %b = mês
 * abreviado — todos na língua do sistema (o GLib usa a locale pt_BR).
 *
 * @param {GLib.DateTime} dt
 * @returns {string}
 */
export function formatShortDate(dt) {
    /* Translators: date in the top bar clock, e.g. "Wed, Nov 11". Uses
     * GLib.DateTime.format() codes: %a weekday, %-d day, %b month. */
    return dt.format(_('%a, %b %-d'));
}

/**
 * Hora no formato escolhido em Configurações › Data e Hora (24 h ou AM/PM).
 *
 * @param {GLib.DateTime} dt
 * @param {boolean} use24h
 * @param {boolean} [seconds] - com segundos (opção do GNOME)
 * @returns {string}
 */
export function formatTime(dt, use24h, seconds = false) {
    if (seconds) {
        /* Translators: time with seconds, 24-hour format (GLib.DateTime.format codes). */
        const fmt24s = pgettext('time format', '%H:%M:%S');
        /* Translators: time with seconds, 12-hour format (GLib.DateTime.format codes). */
        const fmt12s = pgettext('time format', '%-l:%M:%S %p');
        return dt.format(use24h ? fmt24s : fmt12s);
    }
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

/**
 * Porcentagem com o símbolo: "65%". Intl usa a locale do sistema (em pt-BR
 * também é "65%", sem espaço).
 *
 * @param {number} fraction - 0 a 1 (ou mais, no volume amplificado)
 * @returns {string}
 */
export function formatPercent(fraction) {
    return new Intl.NumberFormat(undefined, {style: 'percent', maximumFractionDigits: 0})
        .format(fraction);
}

/**
 * Duração curta: "3 h 20 min", "45 min".
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) {
        /* Translators: a duration; {h} = hours, {m} = minutes (two digits). */
        return _('{h} h {m} min').replace('{h}', h).replace('{m}', String(m).padStart(2, '0'));
    }
    /* Translators: a duration in minutes. */
    return _('{m} min').replace('{m}', m);
}

/**
 * Texto da bateria (dica do ícone e subtítulo no menu de status):
 * "78% · 3 h 20 min restantes", "Carregando · 1 h 05 min até completar".
 *
 * @param {object} s - estado do PowerService
 * @returns {string}
 */
export function formatBatteryStatus(s) {
    const parts = [];
    if (s.charging) {
        parts.push(T.charging);
        if (s.timeToFull > 0) {
            /* Translators: battery, e.g. "1 h 05 min until full". */
            parts.push(_('{time} until full').replace('{time}', formatDuration(s.timeToFull)));
        }
    } else if (s.pluggedIn) {
        parts.push(s.full ? T.charged : T.pluggedIn);
    } else {
        parts.push(formatPercent(s.percentage / 100));
        if (s.timeToEmpty > 0) {
            /* Translators: battery, e.g. "3 h 20 min left". */
            parts.push(_('{time} left').replace('{time}', formatDuration(s.timeToEmpty)));
        }
    }
    if (s.powerSaver)
        parts.push(T.powerSaver);
    return parts.join(' · ');
}

/**
 * Temperatura arredondada, sem unidade (como no macOS): "28°".
 *
 * @param {number} celsius
 * @param {string} unit - 'celsius' ou 'fahrenheit'
 * @returns {string}
 */
export function formatTemperature(celsius, unit) {
    const value = unit === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius;
    return `${Math.round(value)}°`;
}

/**
 * "25 min" (duração do foco/pausa nas setinhas − e +).
 *
 * @param {number} minutes
 * @returns {string}
 */
export function formatMinutes(minutes) {
    /* Translators: a duration in minutes, e.g. "25 min". */
    return _('{m} min').replace('{m}', minutes);
}

/**
 * Tempo restante do foco: "24:59" (ou "1:04:59").
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Bateria fraca: "20% restantes · conecte o carregador".
 *
 * @param {number} percentage
 * @returns {string}
 */
export function formatLowBattery(percentage) {
    /* Translators: low battery alert, {p} = "20%". */
    return _('{p} left · plug in the charger').replace('{p}', formatPercent(percentage / 100));
}

/**
 * Lembrete de evento: "Reunião em 5 min".
 *
 * @param {string} title
 * @param {number} minutes
 * @returns {string}
 */
export function formatEventSoon(title, minutes) {
    if (minutes <= 0) {
        /* Translators: an event starting now, {title} = its name. */
        return _('{title} is starting').replace('{title}', title);
    }
    /* Translators: an event about to start, e.g. "Weekly sync in 5 min". */
    return _('{title} in {n} min').replace('{title}', title).replace('{n}', minutes);
}

/**
 * "1 arquivo" / "3 arquivos".
 *
 * @param {number} n
 * @returns {string}
 */
export function formatFileCount(n) {
    /* Translators: number of files copied, e.g. "3 files". */
    return ngettext('{n} file', '{n} files', n).replace('{n}', n);
}

/**
 * Há quanto tempo: "agora", "há 5 minutos", "ontem", "há 3 dias". O Intl já
 * fala o idioma do sistema (pt-BR aqui), sem precisar de tradução.
 *
 * @param {number} unixSeconds
 * @returns {string}
 */
export function formatRelativeTime(unixSeconds) {
    const diff = Math.round(unixSeconds - Date.now() / 1000); // negativo = passado
    const rtf = new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'});
    const abs = Math.abs(diff);
    if (abs < 45)
        return rtf.format(0, 'second');
    if (abs < 3600)
        return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400)
        return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
}
