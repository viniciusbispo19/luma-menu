// SPDX-License-Identifier: GPL-3.0-or-later
// As notificações do GNOME, para a página Notificações e o pontinho de "não
// vistas" ao lado do relógio.
//
// Não guardamos nada nosso: lemos as mesmas fontes (MessageTray.Source) e
// notificações que a lista do relógio do GNOME mostra, e reagimos aos sinais
// delas — chegou, mudou, saiu. Fechar/limpar/ativar usa os métodos delas, então
// tudo continua em sincronia com o resto do GNOME.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {NotificationDestroyedReason} from 'resource:///org/gnome/shell/ui/messageTray.js';

export class NotificationStore extends Signals.EventEmitter {
    constructor() {
        super();
        this._sources = new Set();
        // "Não Perturbe" do GNOME = banners desligados (a mesma chave do menu
        // de status e das Configurações).
        this._desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._desktop.connectObject('changed::show-banners', () => this.emit('changed'), this);

        const tray = Main.messageTray;
        tray.connectObject(
            'source-added', (_t, source) => this._addSource(source),
            'source-removed', (_t, source) => this._removeSource(source),
            'queue-changed', () => this.emit('changed'),
            this);
        tray.getSources().forEach(source => this._addSource(source));
    }

    _addSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notification-added', (_s, n) => this._watch(n),
            'notification-removed', () => this.emit('changed'),
            'notify::count', () => this.emit('changed'),
            this);
        source.notifications.forEach(n => this._watch(n));
        this.emit('changed');
    }

    _removeSource(source) {
        source.disconnectObject(this);
        source.notifications.forEach(n => n.disconnectObject(this));
        this._sources.delete(source);
        this.emit('changed');
    }

    /** Título/texto de uma notificação podem mudar depois (ex.: download). */
    _watch(notification) {
        notification.connectObject('notify', (_n, pspec) => {
            if (pspec.name !== 'acknowledged')
                this.emit('changed');
        }, this);
        this.emit('changed');
    }

    /** @returns {MessageTray.Notification[]} mais recentes primeiro */
    get notifications() {
        const all = [];
        for (const source of this._sources)
            all.push(...source.notifications);
        return all.sort((a, b) => b.datetime.compare(a.datetime));
    }

    /**
     * Não vistas — sem contar as que ainda vão aparecer como banner (mesma
     * conta do pontinho do relógio do GNOME).
     */
    get unseenCount() {
        let count = 0;
        for (const source of this._sources)
            count += source.unseenCount;
        return Math.max(0, count - Main.messageTray.queueCount);
    }

    get doNotDisturb() {
        return !this._desktop.get_boolean('show-banners');
    }

    set doNotDisturb(on) {
        this._desktop.set_boolean('show-banners', !on);
    }

    /** A lista apareceu na tela: todas passam a contar como vistas. */
    markAllSeen() {
        for (const n of this.notifications)
            n.acknowledged = true;
    }

    /** "Limpar": fecha todas, como o botão Limpar do GNOME. */
    clear() {
        for (const n of this.notifications)
            n.destroy(NotificationDestroyedReason.DISMISSED);
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        this._desktop.disconnectObject(this);
        for (const source of this._sources) {
            source.disconnectObject(this);
            source.notifications.forEach(n => n.disconnectObject(this));
        }
        this._sources.clear();
    }
}
