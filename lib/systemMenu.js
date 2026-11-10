// SPDX-License-Identifier: GPL-3.0-or-later
// Menu do sistema: o logo da distro no lugar da maçã do macOS.
//
// Suspender/Reiniciar/Desligar/Bloquear/Encerrar sessão usam o SystemActions
// do próprio GNOME Shell — os mesmos objetos do menu de status. Assim:
//  - os diálogos de confirmação são os nativos do GNOME;
//  - os itens ficam cinza quando a ação não é permitida (ex.: bloqueio
//    desativado pelo administrador), igual ao macOS.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AboutDialog} from './aboutDialog.js';
import {launchApp, lookupApp} from './actions.js';
import {ForceQuitDialog} from './forceQuitDialog.js';
import {
    RecentApps, clearRecentDocuments, isRecentHistoryEnabled,
    loadRecentDocuments, openDocument,
} from './recentItems.js';
import {TitleButton} from './titleButton.js';

export class SystemMenu {
    /**
     * @param {MenuBar} bar
     */
    constructor(bar) {
        this._bar = bar;
        this._settings = bar.settings;
        this._systemActions = SystemActions.getDefault();
        this._recentApps = new RecentApps(this._settings);
        this._dialog = null;

        // Atalhos do sistema (para exibir no menu o atalho REAL do usuário).
        this._mediaKeys = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.media-keys',
        });

        // Ctrl+Alt+Esc abre o "Forçar Encerramento" (configurável).
        // ActionMode diz em quais situações o atalho vale: na área de trabalho
        // normal e na Visão Geral (não na tela de bloqueio, por exemplo).
        Main.wm.addKeybinding('force-quit-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.openForceQuit());

        this.button = new TitleButton({
            icon: bar.getSystemIcon(),
            accessibleName: _('System Menu'),
            styleClass: 'luma-menu-system-button',
            buildModel: () => this.buildModel(),
            bar,
        });
    }

    _accel(settings, key) {
        return settings.get_strv(key)[0] ?? '';
    }

    buildModel() {
        const sa = this._systemActions;
        const s = this._settings;
        const userName = GLib.get_real_name() && GLib.get_real_name() !== 'Unknown'
            ? GLib.get_real_name()
            : GLib.get_user_name();

        return [
            {label: _('About This Computer'), activate: () => this.openAbout()},
            {separator: true},
            {
                label: _('System Settings…'),
                activate: () => launchApp('org.gnome.Settings.desktop'),
            },
            {
                label: _('Software Center…'),
                visible: s.get_boolean('system-menu-show-software') &&
                    lookupApp('org.gnome.Software.desktop') !== null,
                activate: () => launchApp('org.gnome.Software.desktop'),
            },
            {separator: true},
            {
                label: _('Recent Items'),
                visible: s.get_boolean('system-menu-show-recent'),
                children: () => this._buildRecentItems(),
            },
            {separator: true},
            {
                label: _('Force Quit…'),
                accel: this._accel(s, 'force-quit-shortcut'),
                visible: s.get_boolean('system-menu-show-force-quit'),
                activate: () => this.openForceQuit(),
            },
            {separator: true},
            {
                label: _('Suspend'),
                visible: s.get_boolean('system-menu-show-power'),
                sensitive: sa.canSuspend,
                activate: () => sa.activateSuspend(),
            },
            {
                label: _('Restart…'),
                visible: s.get_boolean('system-menu-show-power'),
                sensitive: sa.canRestart,
                activate: () => sa.activateRestart(),
            },
            {
                label: _('Shut Down…'),
                visible: s.get_boolean('system-menu-show-power'),
                sensitive: sa.canPowerOff,
                activate: () => sa.activatePowerOff(),
            },
            {separator: true},
            {
                label: _('Lock Screen'),
                accel: this._accel(this._mediaKeys, 'screensaver'),
                sensitive: sa.canLockScreen,
                activate: () => sa.activateLockScreen(),
            },
            {
                label: _('Log Out “%s”…').format(userName),
                accel: this._accel(this._mediaKeys, 'logout'),
                sensitive: sa.canLogout,
                activate: () => sa.activateLogout(),
            },
        ];
    }

    /** Submenu "Itens Recentes" (assíncrono: lê o disco). */
    async _buildRecentItems() {
        const nodes = [{header: _('Applications')}];
        const apps = this._recentApps.getApps();
        if (apps.length) {
            for (const app of apps) {
                nodes.push({
                    label: app.get_name(),
                    icon: app.get_icon(),
                    activate: () => {
                        app.activate();
                        Main.overview.hide();
                    },
                });
            }
        } else {
            nodes.push({label: _('No recent applications'), sensitive: false});
        }

        nodes.push({separator: true}, {header: _('Documents')});
        if (!isRecentHistoryEnabled()) {
            nodes.push({label: _('File history is turned off in Privacy settings'), sensitive: false});
        } else {
            const docs = await loadRecentDocuments();
            if (docs.length) {
                for (const doc of docs) {
                    nodes.push({
                        label: doc.name,
                        icon: doc.icon,
                        activate: () => openDocument(doc.uri),
                    });
                }
            } else {
                nodes.push({label: _('No recent documents'), sensitive: false});
            }
        }

        nodes.push({separator: true}, {
            label: _('Clear Menu'),
            activate: () => {
                this._recentApps.clear();
                clearRecentDocuments();
            },
        });
        return nodes;
    }

    /** Só um diálogo nosso aberto por vez. */
    _showDialog(dialog) {
        this._dialog?.close();
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        dialog.open();
    }

    openAbout() {
        this._showDialog(new AboutDialog(this._bar.getSystemIcon()));
    }

    openForceQuit() {
        this._showDialog(new ForceQuitDialog());
    }

    /** @param {Gio.Icon} gicon */
    setIcon(gicon) {
        this.button.setIcon(gicon);
    }

    destroy() {
        Main.wm.removeKeybinding('force-quit-shortcut');
        this._dialog?.destroy();
        this._dialog = null;
        this._recentApps.destroy();
        this.button.destroy();
    }
}
