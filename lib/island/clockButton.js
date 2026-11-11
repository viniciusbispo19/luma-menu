// SPDX-License-Identifier: GPL-3.0-or-later
// O relógio no canto direito da barra, como no macOS ("qua, 11 de nov 13:54").
//
// É um PanelMenu.Button — o mesmo tipo de botão do relógio do GNOME e dos
// títulos da barra de menus. Por isso:
//   - herda do tema a fonte e a cor, igual aos outros itens da barra;
//   - clicar abre o pop-up (o "balão" do GNOME) com as abas do Isle; Esc ou
//     clicar fora fecha; com outro menu da barra aberto, passar o mouse troca
//     para este.
//
// Antes da data fica um espaço para as "atividades vivas" (música tocando,
// timer de foco), preenchido nas próximas fases.
//
// O relógio NÃO usa um timer nosso: o GnomeDesktop.WallClock (o mesmo do
// relógio do GNOME) avisa uma vez por minuto, e também quando o computador
// volta da suspensão, o fuso muda ou você troca 12/24 h nas Configurações.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {LumaMenu} from '../popup.js';
import {formatShortDate, formatTime} from './strings.js';

export const ClockButton = GObject.registerClass(
class LumaMenuIslandClock extends PanelMenu.Button {
    /**
     * @param {Gio.Settings} settings - as do Luma Menu
     * @param {object} appearance - a dos menus do Luma (opacidade, cantos…)
     */
    _init(settings, appearance) {
        // true = não criar o menu padrão; usamos o LumaMenu (o mesmo pop-up
        // dos menus da barra), alinhado pela DIREITA do relógio.
        super._init(0.5, '', true);
        this.add_style_class_name('luma-island-clock');
        this._settings = settings;

        const box = new St.BoxLayout({
            style_class: 'luma-island-clock-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(box);

        // Temperatura (ícone simbólico do tema + "28°"). Some sem dado.
        this.weather = new St.BoxLayout({
            style_class: 'luma-island-weather',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.weatherIcon = new St.Icon({
            style_class: 'luma-island-weather-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.weatherLabel = new St.Label({
            style_class: 'luma-island-weather-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.weather.add_child(this.weatherIcon);
        this.weather.add_child(this.weatherLabel);
        box.add_child(this.weather);

        // Atividades vivas (Fase 2): música, timer… — vazio por enquanto.
        this.activities = new St.BoxLayout({
            style_class: 'luma-island-activities',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this.activities);

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
        this.label_actor = this._timeLabel;

        // setMenu() também liga o clique do PanelMenu.Button.
        this.setMenu(new LumaMenu(this, appearance, 1.0));

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._update(), this);
        this._settings.connectObject('changed::island-show-date', () => this._update(), this);

        this.connect('destroy', () => {
            this._wallClock.disconnectObject(this);
            this._wallClock = null;
            this._settings.disconnectObject(this);
        });
        this._update();
    }

    /**
     * @param {object|null} value - do WeatherService ({celsius, icon, stale})
     * @param {string} text - temperatura já formatada ("28°")
     */
    setWeather(value, text) {
        this.weather.visible = Boolean(value);
        if (!value)
            return;
        this.weatherIcon.icon_name = value.icon;
        this.weatherLabel.text = text;
        // Sem atualizar há muito tempo (ou offline): levemente esmaecido.
        this.weather.opacity = value.stale ? 150 : 255;
    }

    _update() {
        const now = GLib.DateTime.new_now_local();
        const use24h = this._interface.get_string('clock-format') === '24h';
        this._timeLabel.text = formatTime(now, use24h);
        this._dateLabel.text = formatShortDate(now);
        this._dateLabel.visible = this._settings.get_boolean('island-show-date');
        // Leitores de tela leem "qua, 11 de nov 13:54".
        this.accessible_name = this._dateLabel.visible
            ? `${this._dateLabel.text} ${this._timeLabel.text}`
            : this._timeLabel.text;
    }
});
