// SPDX-License-Identifier: GPL-3.0-or-later
// Página Foco (Pomodoro) do pop-up do relógio.
//
//        ╭───────╮        Foco    −  25 min  +
//       │  24:59  │       Pausa   −   5 min  +
//       │  Foco   │
//        ╰───────╯        [ Iniciar ]  [ Redefinir ]
//
// O anel enche conforme a fase passa. Enquanto o timer roda, as durações
// ficam travadas (como no Isle). O tique de 1 s que atualiza o anel e os
// números só existe com a página VISÍVEL e o timer RODANDO.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Cairo from 'cairo';

import {T, formatCountdown, formatMinutes} from '../strings.js';

const TICK_MS = 1000;

export class FocusPage {
    /**
     * @param {Gio.Settings} settings
     * @param {FocusTimer} timer
     */
    constructor(settings, timer) {
        this.id = 'focus';
        this._settings = settings;
        this._timer = timer;
        this._visible = false;
        this._tickId = 0;

        this.actor = new St.BoxLayout({style_class: 'luma-focus'});

        // Anel + tempo no meio.
        const ringBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'luma-focus-ring-box',
        });
        this._ring = new St.DrawingArea({style_class: 'luma-focus-ring'});
        this._ring.connect('repaint', area => this._paintRing(area));
        ringBox.add_child(this._ring);
        const center = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time = new St.Label({style_class: 'luma-focus-time', x_align: Clutter.ActorAlign.CENTER});
        this._phase = new St.Label({style_class: 'luma-focus-phase', x_align: Clutter.ActorAlign.CENTER});
        center.add_child(this._time);
        center.add_child(this._phase);
        ringBox.add_child(center);
        this.actor.add_child(ringBox);

        // Durações e botões.
        const side = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'luma-focus-side',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._workStepper = this._stepper(T.focus, 'work');
        this._breakStepper = this._stepper(T.focusBreak, 'break');
        side.add_child(this._workStepper.box);
        side.add_child(this._breakStepper.box);

        const buttons = new St.BoxLayout({style_class: 'luma-focus-buttons'});
        this._main = new St.Button({style_class: 'luma-island-pill luma-focus-main', can_focus: true});
        this._main.connect('clicked', () => {
            if (timer.status === 'running')
                timer.pause();
            else
                timer.start();
        });
        this._reset = new St.Button({style_class: 'luma-island-pill', label: T.reset, can_focus: true});
        this._reset.connect('clicked', () => timer.reset());
        buttons.add_child(this._main);
        buttons.add_child(this._reset);
        side.add_child(buttons);
        this.actor.add_child(side);

        timer.connectObject('changed', () => this._sync(), this);
        this.actor.connect('destroy', () => {
            this._stopTick();
            this._timer.disconnectObject(this);
        });
        this._sync();
    }

    _stepper(label, phase) {
        const box = new St.BoxLayout({style_class: 'luma-focus-stepper'});
        box.add_child(new St.Label({
            text: label,
            style_class: 'luma-focus-stepper-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const minus = new St.Button({
            style_class: 'luma-focus-step',
            child: new St.Icon({icon_name: 'list-remove-symbolic'}),
            can_focus: true,
        });
        const value = new St.Label({style_class: 'luma-focus-step-value', y_align: Clutter.ActorAlign.CENTER});
        const plus = new St.Button({
            style_class: 'luma-focus-step',
            child: new St.Icon({icon_name: 'list-add-symbolic'}),
            can_focus: true,
        });
        // Clique: ±1 min; com Shift: ±5 (para chegar rápido em 45, 50…).
        minus.connect('clicked', () => this._timer.adjust(phase, -stepSize()));
        plus.connect('clicked', () => this._timer.adjust(phase, stepSize()));
        box.add_child(minus);
        box.add_child(value);
        box.add_child(plus);
        return {box, minus, plus, value};
    }

    get title() {
        return T.focus;
    }

    /** "Viva" com o timer rodando: o pop-up abre direto aqui. */
    get isLive() {
        return this._timer.status === 'running';
    }

    show() {
        this._visible = true;
        this._sync();
    }

    hide() {
        this._visible = false;
        this._stopTick();
    }

    _sync() {
        const timer = this._timer;
        const idle = timer.status === 'idle';
        this._main.label = timer.status === 'running' ? T.pause
            : timer.status === 'paused' ? T.resume : T.start;
        this._reset.visible = !idle || timer.phase === 'break';

        // Durações travadas enquanto o timer anda (como no Isle).
        for (const [stepper, key] of [[this._workStepper, 'focus-work-minutes'],
            [this._breakStepper, 'focus-break-minutes']]) {
            stepper.value.text = formatMinutes(this._settings.get_int(key));
            stepper.minus.reactive = stepper.plus.reactive = idle;
            stepper.box.opacity = idle ? 255 : 120;
        }
        this._tick();

        const needed = this._visible && timer.status === 'running';
        if (needed && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stopTick();
        }
    }

    _tick() {
        this._time.text = formatCountdown(this._timer.remaining);
        this._phase.text = this._timer.phase === 'work' ? T.focus : T.focusBreak;
        this._ring.queue_repaint();
    }

    _stopTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
    }

    /** @param {St.DrawingArea} area */
    _paintRing(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const node = area.get_theme_node();
        const fg = node.get_foreground_color();
        const accent = node.lookup_color('-luma-ring-color', false);
        const [r, g, b] = accent[0]
            ? [accent[1].red, accent[1].green, accent[1].blue]
            : [fg.red, fg.green, fg.blue];
        const line = 7;
        const radius = Math.min(w, h) / 2 - line / 2;
        const cx = w / 2, cy = h / 2;

        // Trilho.
        cr.setLineWidth(line);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.15);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Progresso (do topo, no sentido horário). Pausado: mais apagado.
        const progress = Math.min(1, Math.max(0, this._timer.progress));
        if (progress > 0) {
            const alpha = this._timer.status === 'paused' ? 0.5 : 1;
            cr.setSourceRGBA(r / 255, g / 255, b / 255, alpha);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }

    destroy() {
        this.actor.destroy();
    }
}

/** ±5 min com Shift apertado; senão ±1. */
function stepSize() {
    const [, , mods] = global.get_pointer();
    return mods & Clutter.ModifierType.SHIFT_MASK ? 5 : 1;
}
