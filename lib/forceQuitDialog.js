// SPDX-License-Identifier: GPL-3.0-or-later
// Janela "Forçar Encerramento de Aplicativos", como a do macOS (⌥⌘⎋):
// lista os apps abertos; você escolhe um e clica em "Forçar Encerramento".
//
// Como encerramos: Meta.Window.kill() — a API do Mutter que mata o processo
// dono da janela (SIGKILL), funcione o app em Wayland ou XWayland. É o mesmo
// que o botão "Forçar saída" do diálogo "não está respondendo" do GNOME faz.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getAppWindows} from './actions.js';

const ICON_SIZE = 32;

export const ForceQuitDialog = GObject.registerClass(
class LumaMenuForceQuitDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'luma-force-quit-dialog'});
        this._appSystem = Shell.AppSystem.get_default();
        this._selectedId = Shell.WindowTracker.get_default().focus_app?.get_id() ?? null;
        this._rows = new Map();

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'luma-force-quit-box',
            x_expand: true,
        });
        this.contentLayout.add_child(box);

        box.add_child(new St.Label({
            style_class: 'luma-force-quit-title',
            text: _('Force Quit Applications'),
        }));
        const hint = new St.Label({
            style_class: 'luma-force-quit-hint',
            text: _('If an app doesn’t respond for a while, select its name and click Force Quit.'),
        });
        hint.clutter_text.line_wrap = true;
        box.add_child(hint);

        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'luma-force-quit-list',
        });
        const scroll = new St.ScrollView({
            style_class: 'luma-force-quit-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._list,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(scroll);

        this.setButtons([{
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Force Quit'),
            action: () => this._confirm(),
            default: true,
        }]);
        this._forceQuitButton = this.buttonLayout.get_last_child();

        // A lista se atualiza sozinha se um app abrir ou fechar. Como `this` é
        // um ator, o connectObject desconecta sozinho quando ele é destruído.
        this._appSystem.connectObject('app-state-changed', () => this._refresh(), this);
        this._confirmDialog = null;
        this.connect('destroy', () => this._confirmDialog?.destroy());
        this._refresh();
    }

    _refresh() {
        const apps = this._appSystem.get_running()
            .filter(app => getAppWindows(app).length > 0)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));

        this._list.destroy_all_children();
        this._rows.clear();
        for (const app of apps) {
            const row = new St.Button({
                style_class: 'luma-force-quit-row',
                can_focus: true,
                x_expand: true,
                toggle_mode: false,
            });
            // x_align START: ícone e nome à esquerda, como no macOS (o
            // St.Button centraliza o conteúdo por padrão).
            const content = new St.BoxLayout({
                style_class: 'luma-force-quit-row-box',
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
            });
            content.add_child(app.create_icon_texture(ICON_SIZE));
            content.add_child(new St.Label({
                text: app.get_name(),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.set_child(content);
            row.connect('clicked', () => this._select(app.get_id()));
            row.connect('key-focus-in', () => this._select(app.get_id()));
            this._list.add_child(row);
            this._rows.set(app.get_id(), {row, app});
        }

        if (!this._rows.has(this._selectedId))
            this._selectedId = apps[0]?.get_id() ?? null;
        this._select(this._selectedId);
    }

    _select(appId) {
        this._selectedId = appId;
        for (const [id, {row}] of this._rows)
            row.checked = id === appId;
        this._forceQuitButton.reactive = appId !== null;
    }

    _confirm() {
        const entry = this._rows.get(this._selectedId);
        if (!entry)
            return;
        const {app} = entry;

        // Confirmação, como no macOS: o app perde o que não foi salvo.
        const confirm = new ModalDialog.ModalDialog({styleClass: 'luma-force-quit-confirm'});
        this._confirmDialog = confirm;
        confirm.connect('destroy', () => {
            if (this._confirmDialog === confirm)
                this._confirmDialog = null;
        });
        confirm.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Force “%s” to quit?').format(app.get_name()),
            description: _('You will lose any unsaved changes.'),
        }));
        confirm.setButtons([{
            label: _('Cancel'),
            action: () => confirm.close(),
            key: Clutter.KEY_Escape,
        }, {
            label: _('Force Quit'),
            action: () => {
                for (const window of getAppWindows(app))
                    window.kill();
                confirm.close();
            },
            default: true,
        }]);
        confirm.open();
    }

});
