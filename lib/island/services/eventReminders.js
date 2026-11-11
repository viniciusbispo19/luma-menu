// SPDX-License-Identifier: GPL-3.0-or-later
// Lembrete antes de eventos do calendário ("Reunião em 5 min"), com o botão
// "Entrar" quando o evento tem link de Meet, Zoom, Teams ou Webex.
//
// Os eventos vêm das MESMAS agendas do relógio do GNOME (contas online,
// Evolution…), por uma fonte de eventos nossa — a mesma classe do Shell
// (Calendar.DBusEventSource) — para não mexer no intervalo de datas que o
// calendário do pop-up está mostrando.
//
// Sem tique: agendamos UM timeout para "N minutos antes" do próximo evento.
// Eventos de dia inteiro não avisam.
//
// O link da reunião não vem do servidor de calendário do GNOME (ele só manda
// título e horários). Para achá-lo, carregamos a biblioteca do Evolution
// (ECal) SOB DEMANDA — só na hora de avisar — e lemos o evento inteiro, de
// forma assíncrona. Se der errado, o lembrete aparece sem o botão.

import Gio from 'gi://Gio';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import {T, formatEventSoon, formatTimeRange} from '../strings.js';
import {TimeoutRegistry, debug, logError} from '../../util.js';

const DAY = 24 * 60 * 60 * 1000;
/** Links de reunião reconhecidos (Meet, Zoom, Teams, Webex). */
const MEETING_HOSTS = [
    'meet\\.google\\.com',
    '(?:[\\w-]+\\.)?zoom\\.us',
    'teams\\.microsoft\\.com',
    'teams\\.live\\.com',
    '[\\w-]+\\.webex\\.com',
];
const MEETING_LINK = new RegExp(`https?://(?:${MEETING_HOSTS.join('|')})/[^\\s"'<>\\\\]+`, 'i');

export class EventReminders {
    /**
     * @param {Gio.Settings} settings
     * @param {AlertPresenter} alerts
     */
    constructor(settings, alerts) {
        this._settings = settings;
        this._alerts = alerts;
        this._timers = new TimeoutRegistry();
        this._alarm = 0;
        this._dayTimer = 0;
        this._fired = new Set(); // eventos já avisados (id + início)
        this._cancellable = new Gio.Cancellable();
        this._ecal = null; // módulos carregados sob demanda

        this._source = new Calendar.DBusEventSource();
        this._source.connectObject('changed', () => this._schedule(), this);
        settings.connectObject(
            'changed::alert-events', () => this._schedule(),
            'changed::event-reminder-minutes', () => this._schedule(),
            this);
        this._requestRange();
    }

    /** Pede hoje e amanhã; à meia-noite, pede de novo (um timeout por dia). */
    _requestRange() {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + 2 * DAY);
        this._source.requestRange(start, end);
        this._timers.remove(this._dayTimer);
        this._dayTimer = this._timers.add(start.getTime() + DAY - Date.now() + 1000, () => {
            this._dayTimer = 0;
            this._requestRange();
        });
        this._schedule();
    }

    get _lead() {
        return this._settings.get_int('event-reminder-minutes') * 60 * 1000;
    }

    /** Agenda o aviso do próximo evento com horário. */
    _schedule() {
        this._timers.remove(this._alarm);
        this._alarm = 0;
        if (!this._settings.get_boolean('alert-events') || this._source.isLoading)
            return;

        const now = Date.now();
        const events = this._source.getEvents(new Date(now), new Date(now + 2 * DAY))
            .filter(e => !isAllDay(e) && e.date.getTime() > now &&
                !this._fired.has(`${e.id}@${e.date.getTime()}`))
            .sort((a, b) => a.date - b.date);
        const next = events[0];
        if (!next)
            return;
        const fireIn = Math.max(0, next.date.getTime() - this._lead - now);
        debug('evento: aviso de', next.summary, 'em', Math.round(fireIn / 1000), 's');
        this._alarm = this._timers.add(fireIn, () => {
            this._alarm = 0;
            this._fire(next);
        });
    }

    async _fire(event) {
        this._fired.add(`${event.id}@${event.date.getTime()}`);
        this._schedule(); // já deixa o próximo agendado

        let link = null;
        try {
            link = await this._findMeetingLink(event.id);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug('evento: não deu para ler o link:', e.message);
        }
        if (this._cancellable.is_cancelled())
            return;

        const minutes = Math.max(0, Math.round((event.date.getTime() - Date.now()) / 60000));
        const use24h = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('clock-format') === '24h';
        const service = link ? meetingService(link) : '';
        this._alerts.showMessage({
            key: `event-${event.id}@${event.date.getTime()}`,
            iconName: link ? 'camera-video-symbolic' : 'x-office-calendar-symbolic',
            title: formatEventSoon(event.summary || T.calendar, minutes),
            subtitle: [formatTimeRange(event.date, event.end, use24h), service].filter(Boolean).join(' · '),
            actionLabel: link ? T.join : null,
            onAction: link ? () => openUri(link) : null,
            // Fica até a hora do evento (ou até você fechar).
            duration: Math.max(8000, event.date.getTime() - Date.now()),
        });
    }

    /**
     * Lê o evento inteiro no Evolution e procura um link de reunião (descrição,
     * local, URL, dados de conferência do Google…).
     *
     * O id do servidor de calendário do GNOME é "agenda\nevento\nrecorrência".
     *
     * @param {string} id
     * @returns {Promise<string|null>}
     */
    async _findMeetingLink(id) {
        const [sourceUid, uid, rid = ''] = id.split('\n');
        if (!sourceUid || !uid)
            return null;

        // Carregado só agora (e uma vez): a biblioteca do Evolution não entra
        // no processo do Shell se você nunca tiver um evento por perto.
        if (!this._ecal) {
            const [{default: ECal}, {default: EDataServer}] = await Promise.all([
                import('gi://ECal?version=2.0'),
                import('gi://EDataServer?version=1.2'),
            ]);
            Gio._promisify(EDataServer.SourceRegistry, 'new', 'new_finish');
            Gio._promisify(ECal.Client, 'connect', 'connect_finish');
            Gio._promisify(ECal.Client.prototype, 'get_object', 'get_object_finish');
            const registry = await EDataServer.SourceRegistry.new(this._cancellable);
            this._ecal = {ECal, registry, clients: new Map()};
        }
        const {ECal, registry, clients} = this._ecal;
        let client = clients.get(sourceUid);
        if (!client) {
            const source = registry.ref_source(sourceUid);
            if (!source)
                return null;
            client = await ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 10, this._cancellable);
            clients.set(sourceUid, client);
        }
        // Conforme a versão do GJS, vem [ok, componente] ou só o componente.
        const result = await client.get_object(uid, rid || null, this._cancellable);
        const component = Array.isArray(result) ? result[result.length - 1] : result;
        if (!component)
            return null;
        // O iCal "dobra" linhas longas (quebra + espaço): desdobramos antes de
        // procurar o link.
        const ical = component.as_ical_string().replace(/\r?\n[ \t]/g, '');
        return ical.match(MEETING_LINK)?.[0]?.replace(/\\[,;n]$/, '') ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        this._timers.clear();
        this._settings.disconnectObject(this);
        this._source.disconnectObject(this);
        this._source.destroy();
        this._ecal = null;
    }
}

/** Dia inteiro: começa à meia-noite e dura dias inteiros. */
function isAllDay(event) {
    const start = event.date, end = event.end;
    return start.getHours() === 0 && start.getMinutes() === 0 &&
        end - start >= DAY && (end - start) % DAY === 0;
}

function meetingService(link) {
    if (/meet\.google\.com/i.test(link))
        return 'Google Meet';
    if (/zoom\.us/i.test(link))
        return 'Zoom';
    if (/teams\./i.test(link))
        return 'Microsoft Teams';
    if (/webex\.com/i.test(link))
        return 'Webex';
    return '';
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, 'abrindo o link da reunião');
    }
}
