// SPDX-License-Identifier: GPL-3.0-or-later
// A barra de menus: uma caixa horizontal que fica no lado esquerdo do painel
// e contém os "títulos" (ícone do sistema, nome do app, Arquivo, Editar…).
//
// Cada título é um PanelMenu.Button — o mesmo tipo de botão que o próprio
// GNOME usa no relógio e no menu de status. Vantagem: herdamos de graça o
// visual do tema, o foco por teclado e a abertura/fechamento do menu.

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SystemMenuButton} from './systemMenu.js';

export const MenuBar = GObject.registerClass(
class LumaMenuBar extends St.BoxLayout {
    /**
     * @param {Gio.File} extensionDir - pasta da extensão (para achar os ícones)
     */
    _init(extensionDir) {
        super._init({
            name: 'lumaMenuBar',
            style_class: 'luma-menu-bar',
            // Ocupa toda a altura do painel, para os botões ficarem
            // centralizados verticalmente como os do GNOME.
            y_expand: true,
        });

        this._systemButton = new SystemMenuButton(extensionDir.get_child('icons'));
        this._addTitle(this._systemButton);
    }

    /**
     * Adiciona um título à barra.
     *
     * @param {PanelMenu.Button} button - o título a adicionar
     */
    _addTitle(button) {
        // O PanelMenu.Button vive dentro de um St.Bin chamado `container`;
        // é o container que entra na caixa (é assim que o painel faz também).
        this.add_child(button.container);

        // Registrar o menu no gerenciador do painel é o que dá o comportamento
        // do macOS: com um menu aberto, passar o mouse em outro título troca
        // de menu sem clicar. Botões sem menu usam um "PopupDummyMenu", que
        // não deve ser registrado — por isso o teste de tipo.
        if (button.menu instanceof PopupMenu.PopupMenu)
            Main.panel.menuManager.addMenu(button.menu);
    }
});
