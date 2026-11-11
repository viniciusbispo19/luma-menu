// SPDX-License-Identifier: GPL-3.0-or-later
// Página Notificações do pop-up do relógio.
//
//   [🌙 Não Perturbe]                                         [Limpar]
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [ícone] App · agora mesmo                                ×   │
//   │ Título em negrito                                            │
//   │ Texto da notificação (até 2 linhas)                          │
//   │ [Responder] [Marcar como lida]                               │
//   └──────────────────────────────────────────────────────────────┘
//
// São as MESMAS notificações da lista do relógio do GNOME (o NotificationStore
// lê as fontes do MessageTray): clicar ativa, × fecha, os botões chamam as
// ações do app, "Limpar" fecha todas e "Não Perturbe" é a chave do GNOME.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {T} from '../strings.js';
import {logError} from '../../util.js';

/** Quantas notificações cabem na lista (rola se tiver mais). */
const MAX_ROWS = 50;
/** O St não limita linhas: textos longos são cortados (~3 linhas). */
const MAX_BODY_CHARS = 180;

export class NotificationsPage {
    /**
     * @param {Gio.Settings} settings
     * @param {NotificationStore} store
     * @param {Function} closePopup - fecha o pop-up do relógio
     */
    constructor(settings, store, closePopup) {
        this.id = 'notifications';
        this._store = store;
        this._closePopup = closePopup;
        this._visible = false;

        this.actor = new St.BoxLayout({
            style_class: 'luma-notifications',
            orientation: Clutter.Orientation.VERTICAL,
        });

        // Barra de cima: Não Perturbe (alterna) e Limpar.
        const bar = new St.BoxLayout({style_class: 'luma-notifications-bar'});
        this._dnd = new St.Button({
            style_class: 'luma-island-pill',
            can_focus: true,
            toggle_mode: true,
            child: new St.BoxLayout({style_class: 'luma-island-pill-box'}),
        });
        this._dndIcon = new St.Icon({style_class: 'luma-island-pill-icon'});
        this._dnd.child.add_child(this._dndIcon);
        this._dnd.child.add_child(new St.Label({text: T.doNotDisturb, y_align: Clutter.ActorAlign.CENTER}));
        this._dnd.connect('clicked', () => {
            this._store.doNotDisturb = !this._store.doNotDisturb;
        });
        bar.add_child(this._dnd);
        bar.add_child(new St.Widget({x_expand: true}));
        this._clear = new St.Button({
            style_class: 'luma-island-pill',
            label: T.clear,
            can_focus: true,
        });
        this._clear.connect('clicked', () => this._store.clear());
        bar.add_child(this._clear);
        this.actor.add_child(bar);

        this._dndHint = new St.Label({
            style_class: 'luma-island-placeholder',
            text: T.doNotDisturbOn,
        });
        this._dndHint.clutter_text.line_wrap = true;
        this.actor.add_child(this._dndHint);

        this._list = new St.BoxLayout({
            style_class: 'luma-notifications-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'luma-notifications-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this.actor.add_child(this._scroll);

        this._empty = new St.BoxLayout({
            style_class: 'luma-notifications-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Icon({
            icon_name: 'notifications-disabled-symbolic',
            style_class: 'luma-notifications-empty-icon',
        }));
        this._empty.add_child(new St.Label({
            text: T.noNotifications,
            style_class: 'luma-island-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this.actor.add_child(this._empty);

        store.connectObject('changed', () => this._sync(), this);
        this.actor.connect('destroy', () => this._store.disconnectObject(this));
        this._sync();
    }

    get title() {
        return T.notifications;
    }

    /** "Viva" se chegou algo que você ainda não viu. */
    get isLive() {
        return this._store.unseenCount > 0;
    }

    show() {
        this._visible = true;
        this._sync();
        // Como a lista do GNOME: abriu na tela, conta como vista.
        this._store.markAllSeen();
    }

    hide() {
        this._visible = false;
    }

    _sync() {
        const dnd = this._store.doNotDisturb;
        this._dndIcon.icon_name = dnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic';
        this._dnd.checked = dnd;
        this._dndHint.visible = dnd;

        const notifications = this._store.notifications;
        this._clear.reactive = notifications.length > 0;
        this._clear.opacity = notifications.length > 0 ? 255 : 110;
        this._empty.visible = notifications.length === 0;
        this._scroll.visible = notifications.length > 0;

        // Só monta as linhas com a página na tela (fechada, nada a desenhar).
        if (!this._visible)
            return;
        this._list.destroy_all_children();
        for (const n of notifications.slice(0, MAX_ROWS)) {
            try {
                this._list.add_child(this._buildRow(n));
            } catch (e) {
                logError(e, 'mostrando notificação');
            }
        }
    }

    _buildRow(n) {
        const row = new St.Button({
            style_class: 'luma-notification',
            can_focus: true,
            x_expand: true,
        });
        // x_expand + FILL: o St.Button centraliza o filho por padrão; a
        // notificação ocupa a largura toda, alinhada à esquerda.
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'luma-notification-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        row.set_child(box);
        // Clicar ativa (abre o app/conversa), como no GNOME.
        row.connect('clicked', () => {
            this._closePopup();
            n.activate();
        });

        // Cabeçalho: ícone do app · nome · quando · ×
        const header = new St.BoxLayout({style_class: 'luma-notification-header'});
        const sourceIcon = n.source?.icon;
        if (sourceIcon) {
            header.add_child(new St.Icon({
                gicon: sourceIcon,
                style_class: 'luma-notification-app-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        const meta = new St.Label({
            style_class: 'luma-notification-meta',
            text: [n.source?.title, formatTimeSpan(n.datetime)].filter(Boolean).join(' · '),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        meta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(meta);
        const close = new St.Button({
            style_class: 'luma-notification-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: T.close,
            can_focus: true,
        });
        close.connect('clicked', () => n.destroy());
        header.add_child(close);
        box.add_child(header);

        // Imagem da notificação (ex.: foto do contato) + texto.
        const content = new St.BoxLayout({style_class: 'luma-notification-content'});
        if (n.gicon) {
            content.add_child(new St.Icon({
                gicon: n.gicon,
                style_class: 'luma-notification-image',
                y_align: Clutter.ActorAlign.START,
            }));
        }
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const title = new St.Label({style_class: 'luma-notification-title', text: n.title ?? ''});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);
        if (n.body) {
            const body = new St.Label({style_class: 'luma-notification-body', text: oneParagraph(n.body)});
            body.clutter_text.line_wrap = true;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(body);
        }
        content.add_child(text);
        box.add_child(content);

        // Botões de ação do app ("Responder", "Marcar como lida"…).
        const actions = n.actions ?? [];
        if (actions.length > 0) {
            const buttons = new St.BoxLayout({style_class: 'luma-notification-actions'});
            for (const action of actions) {
                const b = new St.Button({
                    style_class: 'luma-island-pill',
                    label: action.label,
                    can_focus: true,
                });
                b.connect('clicked', () => {
                    this._closePopup();
                    action.activate();
                });
                buttons.add_child(b);
            }
            box.add_child(buttons);
        }
        return row;
    }

    destroy() {
        this.actor.destroy();
    }
}

/** Texto em um parágrafo só, cortado com "…" se for longo demais. */
function oneParagraph(text) {
    const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
    return flat.length > MAX_BODY_CHARS ? `${flat.slice(0, MAX_BODY_CHARS - 1).trimEnd()}…` : flat;
}
