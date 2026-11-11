// SPDX-License-Identifier: GPL-3.0-or-later
// Página Uso do pop-up do relógio: quanto tempo cada app ficou em foco.
//
//   [Hoje] [7 dias]                         Total: 5 h 12 min
//   🟦 Visual Studio Code   ████████████████    2 h 40 min
//   🟧 Firefox              ████████            1 h 20 min
//   …
//                                              [Apagar histórico]
//
// Os números são calculados ao abrir a página (e quando algo muda com ela
// aberta) — nenhum tique de relógio.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {T, formatDuration} from '../strings.js';

const MAX_APPS = 8;
const BAR_WIDTH = 170; // px na escala 1

export class UsagePage {
    /**
     * @param {Gio.Settings} settings
     * @param {AppUsage} usage
     */
    constructor(settings, usage) {
        this.id = 'usage';
        this._usage = usage;
        this._days = 1;
        this._visible = false;

        this.actor = new St.BoxLayout({
            style_class: 'luma-usage',
            orientation: Clutter.Orientation.VERTICAL,
        });

        const top = new St.BoxLayout({style_class: 'luma-usage-top'});
        this._todayButton = this._rangeButton(T.today, 1);
        this._weekButton = this._rangeButton(T.lastSevenDays, 7);
        top.add_child(this._todayButton);
        top.add_child(this._weekButton);
        this._total = new St.Label({
            style_class: 'luma-usage-total',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(this._total);
        this.actor.add_child(top);

        this._list = new St.BoxLayout({
            style_class: 'luma-usage-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.actor.add_child(this._list);
        this._empty = new St.Label({
            style_class: 'luma-island-placeholder',
            text: T.noUsageYet,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._empty);

        const clear = new St.Button({
            style_class: 'luma-island-pill luma-usage-clear',
            label: T.clearUsage,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
        });
        clear.connect('clicked', () => usage.clear());
        this.actor.add_child(clear);

        usage.connectObject('changed', () => {
            if (this._visible)
                this._sync();
        }, this);
        this.actor.connect('destroy', () => this._usage.disconnectObject(this));
    }

    get title() {
        return T.usage;
    }

    get isLive() {
        return false;
    }

    show() {
        this._visible = true;
        this._sync();
    }

    hide() {
        this._visible = false;
    }

    _rangeButton(label, days) {
        const button = new St.Button({
            style_class: 'luma-island-tab',
            label,
            can_focus: true,
        });
        button.connect('clicked', () => {
            this._days = days;
            this._sync();
        });
        return button;
    }

    _sync() {
        for (const [button, days] of [[this._todayButton, 1], [this._weekButton, 7]]) {
            if (this._days === days)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }

        const totals = this._usage.totals(this._days);
        const sum = totals.reduce((s, t) => s + t.seconds, 0);
        this._total.text = sum > 0 ? T.usageTotal.replace('{time}', formatDuration(sum)) : '';
        this._empty.visible = totals.length === 0;

        this._list.destroy_all_children();
        const max = totals[0]?.seconds ?? 1;
        for (const entry of totals.slice(0, MAX_APPS))
            this._list.add_child(this._row(entry, max));
    }

    _row({app, name, seconds}, max) {
        const row = new St.BoxLayout({style_class: 'luma-usage-row'});
        const icon = app?.create_icon_texture(20) ??
            new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 20});
        icon.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(icon);

        const label = new St.Label({
            text: name,
            style_class: 'luma-usage-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(label);

        // Barra proporcional ao app que mais usou.
        // (BoxLayout: a barra começa na esquerda do trilho.)
        const track = new St.BoxLayout({
            style_class: 'luma-usage-track',
            width: BAR_WIDTH,
            y_align: Clutter.ActorAlign.CENTER,
        });
        track.add_child(new St.Widget({
            style_class: 'luma-usage-bar',
            width: Math.max(6, Math.round(BAR_WIDTH * seconds / max)),
            y_expand: true,
        }));
        row.add_child(track);

        row.add_child(new St.Label({
            text: formatDuration(seconds),
            style_class: 'luma-usage-time',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    destroy() {
        this.actor.destroy();
    }
}
