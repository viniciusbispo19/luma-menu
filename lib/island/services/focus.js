// SPDX-License-Identifier: GPL-3.0-or-later
// Timer de foco (Pomodoro): foco → pausa → foco…
//
// Sem tique: o timer guarda a HORA em que a fase acaba e agenda UM timeout
// para esse momento. Quem mostra o tempo restante (página Foco, relógio)
// calcula na hora em que desenha. Usamos a hora do relógio (Date.now) e não o
// relógio monotônico: assim, se o notebook dormir, ao acordar o tempo
// restante está certo.
//
// Durante o foco, liga o Não Perturbe do GNOME (se a opção estiver ligada) e
// devolve como estava ao terminar.
//
// Vive na extensão (não no relógio): a interface da barra é destruída ao
// bloquear a tela, mas o timer continua contando.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export class FocusTimer extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.phase = 'work'; // 'work' | 'break'
        this.status = 'idle'; // 'idle' | 'running' | 'paused'
        this._endsAt = 0; // ms (Date.now) — rodando
        this._remaining = 0; // ms — pausado
        this._timeoutId = 0;
        this._dndByUs = false;
        settings.connectObject(
            'changed::focus-work-minutes', () => this._lengthsChanged(),
            'changed::focus-break-minutes', () => this._lengthsChanged(),
            this);
    }

    /** Duração da fase atual (ms). */
    get length() {
        const key = this.phase === 'work' ? 'focus-work-minutes' : 'focus-break-minutes';
        return this._settings.get_int(key) * 60 * 1000;
    }

    /** Tempo restante agora (ms). */
    get remaining() {
        if (this.status === 'running')
            return Math.max(0, this._endsAt - Date.now());
        if (this.status === 'paused')
            return this._remaining;
        return this.length;
    }

    /** 0 (começo) a 1 (fim da fase). */
    get progress() {
        const length = this.length;
        return length > 0 ? 1 - this.remaining / length : 0;
    }

    start() {
        if (this.status === 'running')
            return;
        const remaining = this.status === 'paused' ? this._remaining : this.length;
        this._endsAt = Date.now() + remaining;
        this.status = 'running';
        this._schedule(remaining);
        this._syncDnd();
        this.emit('changed');
    }

    pause() {
        if (this.status !== 'running')
            return;
        this._remaining = this.remaining;
        this.status = 'paused';
        this._unschedule();
        this.emit('changed');
    }

    /** Volta ao começo da fase de foco. */
    reset() {
        this._unschedule();
        this.status = 'idle';
        this.phase = 'work';
        this._syncDnd();
        this.emit('changed');
    }

    /** Ajusta a duração (só parado): −/+ na página. */
    adjust(phase, deltaMinutes) {
        if (this.status !== 'idle')
            return;
        const key = phase === 'work' ? 'focus-work-minutes' : 'focus-break-minutes';
        const [min, max] = phase === 'work' ? [1, 180] : [1, 60];
        const value = Math.min(max, Math.max(min, this._settings.get_int(key) + deltaMinutes));
        this._settings.set_int(key, value);
    }

    _lengthsChanged() {
        if (this.status === 'idle')
            this.emit('changed');
    }

    _schedule(ms) {
        this._unschedule();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.ceil(ms)), () => {
            this._timeoutId = 0;
            this._phaseEnded();
            return GLib.SOURCE_REMOVE;
        });
    }

    _unschedule() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    /** Fim da fase: prepara a próxima (parada) e avisa quem estiver ouvindo. */
    _phaseEnded() {
        const ended = this.phase;
        this.phase = ended === 'work' ? 'break' : 'work';
        this.status = 'idle';
        this._syncDnd();
        // Um "plim" do tema de sons do sistema.
        global.display.get_sound_player().play_from_theme('complete', '', null);
        this.emit('phase-ended', ended);
        this.emit('changed');
    }

    /** Não Perturbe ligado só durante o FOCO rodando (se a opção pedir). */
    _syncDnd() {
        const want = this.phase === 'work' && this.status === 'running' &&
            this._settings.get_boolean('focus-dnd');
        const showBanners = this._notifications.get_boolean('show-banners');
        if (want && showBanners) {
            this._notifications.set_boolean('show-banners', false);
            this._dndByUs = true;
        } else if (!want && this._dndByUs) {
            // Só desligamos o que NÓS ligamos.
            this._dndByUs = false;
            this._notifications.set_boolean('show-banners', true);
        }
    }

    destroy() {
        this._unschedule();
        this._settings.disconnectObject(this);
        if (this._dndByUs) {
            this._dndByUs = false;
            this._notifications.set_boolean('show-banners', true);
        }
    }
}
