// SPDX-License-Identifier: GPL-3.0-or-later
// Janela "Sobre Este Computador", inspirada no "Sobre Este Mac".
//
// Usamos o ModalDialog do próprio GNOME Shell (o mesmo dos diálogos de
// desligar/encerrar sessão): ele já cuida do escurecimento do fundo, do foco
// por teclado e das animações, e combina com o tema do Shell.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {openSettingsPanel} from './actions.js';
import {getSystemInfo} from './systemInfo.js';
import {logError} from './util.js';

export const AboutDialog = GObject.registerClass(
class LumaMenuAboutDialog extends ModalDialog.ModalDialog {
    /**
     * @param {Gio.Icon} fallbackLogo - ícone usado se a distro não tiver LOGO
     */
    _init(fallbackLogo) {
        super._init({styleClass: 'luma-about-dialog'});
        this._destroyed = false;
        this.connect('destroy', () => (this._destroyed = true));

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'luma-about-box',
            x_expand: true,
        });
        this.contentLayout.add_child(box);

        this._logo = new St.Icon({
            gicon: fallbackLogo,
            icon_size: 96,
            style_class: 'luma-about-logo',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._logo);

        this._title = new St.Label({
            style_class: 'luma-about-title',
            text: '…',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._title);

        this._version = new St.Label({
            style_class: 'luma-about-version',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._version);

        // Grade de duas colunas: rótulo (cinza, à direita) | valor.
        this._gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._grid = new St.Widget({
            style_class: 'luma-about-grid',
            layout_manager: this._gridLayout,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._gridLayout.hookup_style(this._grid);
        box.add_child(this._grid);
        this._row = 0;

        this.setButtons([{
            label: _('More Info…'),
            action: () => {
                openSettingsPanel('system', 'about');
                this.close();
            },
        }, {
            label: _('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            default: true,
        }]);

        this._load().catch(e => logError(e, 'Sobre Este Computador'));
    }

    _addRow(label, value) {
        if (!value)
            return;
        const name = new St.Label({
            style_class: 'luma-about-key',
            text: label,
            x_align: Clutter.ActorAlign.END,
        });
        const text = new St.Label({
            style_class: 'luma-about-value',
            text: value,
            x_align: Clutter.ActorAlign.START,
        });
        text.clutter_text.line_wrap = true;
        this._gridLayout.attach(name, 0, this._row, 1, 1);
        this._gridLayout.attach(text, 1, this._row, 1, 1);
        this._row++;
    }

    async _load() {
        const info = await getSystemInfo();
        if (this._destroyed)
            return;

        // Logo colorido da distro (ex.: fedora-logo-icon), se o tema tiver.
        // Se o tema não tiver o ícone, o St usa o fallback (nosso logo).
        if (info.osLogo) {
            this._logo.fallback_gicon = this._logo.gicon;
            this._logo.gicon = Gio.ThemedIcon.new_from_names(
                [info.osLogo, 'distributor-logo']);
        }

        this._title.text = info.osName;
        this._version.text = info.osVersion
            ? _('Version %s').format(info.osVersion)
            : '';

        this._addRow(_('Computer'), info.model);
        this._addRow(_('Processor'), info.processor);
        this._addRow(_('Memory'), info.memory);
        this._addRow(_('Graphics'), info.graphics);
        if (info.disk)
            this._addRow(_('Disk'), _('%s (%s available)').format(info.disk.size, info.disk.free));
        this._addRow(_('GNOME'), info.gnomeVersion);
        this._addRow(_('Kernel'), info.kernel);
    }
});
