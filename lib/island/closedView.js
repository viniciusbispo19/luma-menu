// SPDX-License-Identifier: GPL-3.0-or-later
// Conteúdo da ilha FECHADA: data e hora (e, nas próximas fases, clima,
// música e o timer de foco ao lado).
//
// É um St.Button: clicar abre a ilha; o clique do meio (Fase 2) vai
// pausar/retomar a música.
//
// O relógio NÃO usa um timer nosso: o GnomeDesktop.WallClock (o mesmo do
// relógio do GNOME) avisa uma vez por minuto, e também quando o computador
// volta da suspensão ou o fuso horário muda.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {T, formatShortDate, formatTime} from './strings.js';

export const ClosedView = GObject.registerClass(
class LumaMenuIslandClosedView extends St.Button {
    /** @param {Gio.Settings} settings - as do Luma Menu */
    _init(settings) {
        super._init({
            style_class: 'luma-island-closed',
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            accessible_name: T.island,
            can_focus: false,
        });
        this._settings = settings;

        const box = new St.BoxLayout({
            style_class: 'luma-island-closed-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.set_child(box);

        this._dateLabel = new St.Label({
            style_class: 'luma-island-date',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeLabel = new St.Label({
            style_class: 'luma-island-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const label of [this._dateLabel, this._timeLabel]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            box.add_child(label);
        }

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock();
        // "clock" muda a cada minuto e quando o formato 12/24 h muda.
        this._wallClock.connectObject('notify::clock', () => this._update(), this);
        this._settings.connectObject('changed::island-show-date', () => this._update(), this);

        this.connect('destroy', () => {
            this._wallClock.disconnectObject(this);
            this._wallClock = null;
            this._settings.disconnectObject(this);
        });
        this._update();
    }

    _update() {
        const now = GLib.DateTime.new_now_local();
        const use24h = this._interface.get_string('clock-format') === '24h';
        this._timeLabel.text = formatTime(now, use24h);
        this._dateLabel.text = formatShortDate(now);
        this._dateLabel.visible = this._settings.get_boolean('island-show-date');
        // Leitores de tela leem "qua, 11 de nov 13:30".
        this.accessible_name = `${this._dateLabel.visible ? `${this._dateLabel.text} ` : ''}${this._timeLabel.text}`;
    }
});
