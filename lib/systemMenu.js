// SPDX-License-Identifier: GPL-3.0-or-later
// Botão do sistema: o logo da distro no lugar da maçã do macOS.
//
// Fase 1: só o ícone. Na Fase 2 este botão ganha o menu completo
// (Sobre Este Computador, Forçar Encerramento, Suspender, Desligar…).

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const SystemMenuButton = GObject.registerClass(
class LumaMenuSystemButton extends PanelMenu.Button {
    /**
     * @param {Gio.File} iconsDir - pasta `icons/` da extensão
     */
    _init(iconsDir) {
        // Parâmetros do PanelMenu.Button:
        //  - 0.0: o menu abre alinhado à ESQUERDA do botão (1.0 seria à direita);
        //  - nome acessível, lido por leitores de tela (Orca);
        //  - true = não criar menu ainda (ele chega na Fase 2).
        super._init(0.0, _('System Menu'), true);
        this.add_style_class_name('luma-menu-system-button');

        // O nome do arquivo termina em "-symbolic.svg" de propósito: o St
        // reconhece esse sufixo e pinta o ícone com a cor do texto do tema.
        // Por isso ele fica branco no WhiteSur-Dark e escuro num tema claro.
        const file = iconsDir.get_child('fedora-symbolic.svg');
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file}),
            style_class: 'luma-menu-system-icon',
        });
        this.add_child(this._icon);
    }
});
