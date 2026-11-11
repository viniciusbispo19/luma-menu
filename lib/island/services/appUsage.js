// SPDX-License-Identifier: GPL-3.0-or-later
// Tempo de uso por aplicativo (desligado por padrão).
//
// Conta o tempo em que cada app esteve EM FOCO, com você presente:
//   - trocou de app → fecha o trecho do anterior e começa o do novo;
//   - 5 minutos sem mexer no teclado/mouse → pausa (o monitor de inatividade
//     do Mutter avisa; ele mesmo avisa quando você volta);
//   - tela bloqueada → pausa.
// Nada de contar de segundo em segundo: só somamos "agora − início" a cada
// mudança. Um trecho que passa da meia-noite é dividido entre os dois dias.
//
// Os totais ficam em ~/.local/share/luma-menu/usage.json (só no seu
// computador): um número de segundos por app por dia, dos últimos 8 dias.
//
// Vive na EXTENSÃO (o bloqueio da tela pausa a contagem, não apaga nada).

import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {dataFile, loadJson, saveJson} from './storage.js';
import {appDisplayName} from '../../windowTracker.js';
import {TimeoutRegistry, logError} from '../../util.js';

const IDLE_AFTER = 5 * 60 * 1000; // ms
const KEEP_DAYS = 8;
/** Gravação no máximo a cada minuto (e ao desativar). */
const SAVE_DELAY = 60 * 1000; // ms

export class AppUsage extends Signals.EventEmitter {
    constructor() {
        super();
        this._file = dataFile('usage.json');
        this._days = {}; // 'AAAA-MM-DD' → {appKey: segundos}
        this._names = {}; // appKey → nome para mostrar
        this._current = null; // {key, since (ms)}
        this._idle = false;
        this._timers = new TimeoutRegistry();
        this._saveTimer = 0;
        this._tracker = Shell.WindowTracker.get_default();

        this._tracker.connectObject('notify::focus-app', () => this._update(), this);
        global.display.connectObject('notify::focus-window', () => this._update(), this);
        Main.sessionMode.connectObject('updated', () => this._update(), this);

        // Inatividade: o Mutter avisa quando você fica 5 min parado; ao voltar,
        // um aviso de "ativo de novo" (que vale uma vez só, por isso é
        // pedido a cada vez).
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatch = this._idleMonitor.add_idle_watch(IDLE_AFTER, () => {
            this._idle = true;
            this._update();
            this._activeWatch = this._idleMonitor.add_user_active_watch(() => {
                this._activeWatch = 0;
                this._idle = false;
                this._update();
            });
        });
        this._activeWatch = 0;

        loadJson(this._file, {}).then(data => {
            if (this._destroyed)
                return;
            // O que já foi contado desde a ativação soma com o salvo.
            for (const [day, apps] of Object.entries(data?.days ?? {})) {
                this._days[day] ??= {};
                for (const [key, seconds] of Object.entries(apps)) {
                    if (Number.isFinite(seconds))
                        this._days[day][key] = (this._days[day][key] ?? 0) + seconds;
                }
            }
            this._names = {...(data?.names ?? {}), ...this._names};
            this._prune();
            this.emit('changed');
        }).catch(e => logError(e, 'lendo o tempo de uso'));

        this._update();
    }

    /** App em foco agora (ou null: sem app, parado ou tela bloqueada). */
    _focusedKey() {
        if (this._idle || Main.sessionMode.isLocked)
            return null;
        const window = global.display.focus_window;
        const app = this._tracker.focus_app;
        if (!app || !window)
            return null;
        // Apps sem .desktop ("window:N") mudam de número a cada abertura: a
        // chave passa a ser a classe da janela.
        const key = app.is_window_backed() ? `wmclass:${window.get_wm_class() ?? ''}` : app.get_id();
        this._names[key] = appDisplayName(app, window);
        return key;
    }

    _update() {
        const key = this._focusedKey();
        if (this._current?.key === key)
            return;
        this._commit();
        this._current = key ? {key, since: Date.now()} : null;
    }

    /** Soma o trecho atual (dividindo na meia-noite) e recomeça a contar agora. */
    _commit() {
        const cur = this._current;
        if (!cur)
            return;
        const end = Date.now();
        let start = cur.since;
        while (start < end) {
            const midnight = new Date(start);
            midnight.setHours(24, 0, 0, 0);
            const stop = Math.min(end, midnight.getTime());
            const day = dayKey(new Date(start));
            this._days[day] ??= {};
            this._days[day][cur.key] = (this._days[day][cur.key] ?? 0) + (stop - start) / 1000;
            start = stop;
        }
        cur.since = end;
        this._prune();
        this._scheduleSave();
        this.emit('changed');
    }

    _prune() {
        const oldest = new Date();
        oldest.setDate(oldest.getDate() - (KEEP_DAYS - 1));
        const limit = dayKey(oldest);
        for (const day of Object.keys(this._days)) {
            if (day < limit)
                delete this._days[day];
        }
    }

    _scheduleSave() {
        if (this._saveTimer)
            return;
        this._saveTimer = this._timers.add(SAVE_DELAY, () => {
            this._saveTimer = 0;
            this._save();
        });
    }

    _save() {
        const used = new Set(Object.values(this._days).flatMap(apps => Object.keys(apps)));
        const names = Object.fromEntries(Object.entries(this._names).filter(([k]) => used.has(k)));
        return saveJson(this._file, {version: 1, days: this._days, names})
            .catch(e => logError(e, 'gravando o tempo de uso'));
    }

    /**
     * Totais por app, do maior para o menor, incluindo o trecho que está
     * rolando agora.
     *
     * @param {number} days - 1 = hoje; 7 = hoje e os 6 dias antes
     * @returns {{key: string, name: string, app: Shell.App|null, seconds: number}[]}
     */
    totals(days) {
        this._commit();
        const totals = {};
        const day = new Date();
        for (let i = 0; i < days; i++) {
            for (const [key, seconds] of Object.entries(this._days[dayKey(day)] ?? {}))
                totals[key] = (totals[key] ?? 0) + seconds;
            day.setDate(day.getDate() - 1);
        }
        const appSystem = Shell.AppSystem.get_default();
        return Object.entries(totals)
            .filter(([, seconds]) => seconds >= 60)
            .map(([key, seconds]) => {
                const app = key.startsWith('wmclass:') ? null : appSystem.lookup_app(key);
                // O nome atual do app (traduzido) quando ele está instalado.
                const name = app?.get_name() ?? this._names[key] ??
                    key.replace(/^wmclass:/, '').replace(/\.desktop$/, '');
                return {key, seconds, app, name};
            })
            .sort((a, b) => b.seconds - a.seconds);
    }

    /** Apaga tudo (botão das preferências). */
    clear() {
        this._days = {};
        this._names = {};
        if (this._current)
            this._current.since = Date.now();
        this._save();
        this.emit('changed');
    }

    destroy() {
        this._destroyed = true;
        this._commit();
        this._timers.clear();
        if (this._saveTimer || Object.keys(this._days).length)
            this._save();
        this._idleMonitor.remove_watch(this._idleWatch);
        if (this._activeWatch)
            this._idleMonitor.remove_watch(this._activeWatch);
        this._tracker.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
    }
}

/** 'AAAA-MM-DD' no fuso local. */
function dayKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
