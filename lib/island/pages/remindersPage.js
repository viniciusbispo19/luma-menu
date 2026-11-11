// SPDX-License-Identifier: GPL-3.0-or-later
// Página Lembretes do pop-up do relógio.
//
//   [ Novo lembrete…                                           ]
//   ○  Comprar café
//   ○  Ligar para o dentista          ← clicar no texto: renomear
//   ✓  ~~Enviar relatório~~           ← marcado: riscado e some
//
// Enter adiciona/confirma, Esc cancela a edição. Renomear para vazio apaga.
// A lista é salva em ~/.local/share/luma-menu/reminders.json (ReminderStore).

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {T} from '../strings.js';

export class RemindersPage {
    /**
     * @param {Gio.Settings} settings
     * @param {ReminderStore} store
     */
    constructor(settings, store) {
        this.id = 'reminders';
        this._store = store;
        this._editing = null; // id do lembrete sendo renomeado
        this._visible = false;

        this.actor = new St.BoxLayout({
            style_class: 'luma-reminders',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._entry = new St.Entry({
            style_class: 'luma-reminders-entry',
            hint_text: T.newReminder,
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => {
            store.add(this._entry.text);
            this._entry.text = '';
        });
        this.actor.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'luma-reminders-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'luma-reminders-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this.actor.add_child(this._scroll);

        this._empty = new St.Label({
            style_class: 'luma-island-placeholder luma-reminders-empty',
            text: T.noReminders,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._empty);

        store.connectObject('changed', () => this._sync(), this);
        this.actor.connect('destroy', () => this._store.disconnectObject(this));
        this._sync();
    }

    get title() {
        return T.reminders;
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
        this._editing = null;
        this._entry.text = '';
    }

    _sync() {
        const items = this._store.items;
        this._empty.visible = items.length === 0;
        this._scroll.visible = items.length > 0;
        if (!this._visible)
            return;
        this._list.destroy_all_children();
        for (const item of items)
            this._list.add_child(this._buildRow(item));
    }

    _buildRow(item) {
        const row = new St.BoxLayout({style_class: 'luma-reminder'});
        if (item.done)
            row.add_style_class_name('luma-reminder-done');

        // Círculo: clique marca como feito.
        const check = new St.Button({
            style_class: 'luma-reminder-check',
            child: new St.Icon({icon_name: item.done ? 'object-select-symbolic' : ''}),
            accessible_name: T.done,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (item.done)
            check.add_style_pseudo_class('checked');
        check.connect('clicked', () => this._store.complete(item.id));
        row.add_child(check);

        if (this._editing === item.id) {
            // Renomeando no lugar.
            const entry = new St.Entry({
                style_class: 'luma-reminders-entry',
                text: item.text,
                x_expand: true,
                can_focus: true,
            });
            const finish = save => {
                if (this._editing !== item.id)
                    return;
                this._editing = null;
                if (save)
                    this._store.rename(item.id, entry.text);
                else
                    this._sync();
            };
            entry.clutter_text.connect('activate', () => finish(true));
            entry.clutter_text.connect('key-focus-out', () => finish(true));
            // Esc cancela (KeyController: o jeito atual do Clutter de ouvir
            // teclas, o mesmo que o Shell 51 usa).
            const keys = new Clutter.KeyController();
            keys.connect('key-press', () => {
                const [, symbol] = keys.get_key();
                if (symbol !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                finish(false);
                return Clutter.EVENT_STOP;
            });
            entry.clutter_text.add_action(keys);
            row.add_child(entry);
            // O foco vai para o campo depois que ele entra no palco.
            entry.connect('notify::mapped', () => {
                if (entry.mapped) {
                    entry.grab_key_focus();
                    entry.clutter_text.set_selection(0, -1);
                }
            });
            return row;
        }

        const text = new St.Button({
            style_class: 'luma-reminder-text',
            x_expand: true,
            can_focus: true,
        });
        const label = new St.Label({text: item.text, x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.set_child(label);
        text.connect('clicked', () => {
            if (item.done)
                return;
            this._editing = item.id;
            this._sync();
        });
        row.add_child(text);
        return row;
    }

    destroy() {
        this.actor.destroy();
    }
}
