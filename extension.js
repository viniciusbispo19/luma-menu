// SPDX-License-Identifier: GPL-3.0-or-later
// Luma Menu — ponto de entrada da extensão.
//
// O GNOME Shell importa este arquivo e cria UMA instância da classe exportada
// como `default`. Depois ele chama enable() e disable() quantas vezes quiser:
// ao ligar/desligar a extensão, ao bloquear a tela (o Shell desativa as
// extensões no bloqueio e reativa ao desbloquear), ao atualizar a extensão…
//
// Regra de ouro do extensions.gnome.org: NADA é criado no construtor ou no
// nível do módulo; tudo nasce no enable() e tudo é destruído no disable().
// Assim, desligar a extensão deixa o Shell exatamente como estava.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MenuBar} from './lib/menuBar.js';
import {PanelLayout} from './lib/panelLayout.js';
import {setDebug} from './lib/util.js';

export default class LumaMenuExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setDebug(this._settings.get_boolean('debug'));
        this._settings.connectObject('changed::debug',
            () => setDebug(this._settings.get_boolean('debug')), this);

        // A barra é um único ator (St.BoxLayout) com todos os títulos dentro.
        this._menuBar = new MenuBar(this);

        // `_leftBox` é a caixa da esquerda do painel. O "_" indica que é
        // interno do Shell (não há API pública para inserir um ator qualquer
        // ali — `addToStatusArea` só aceita UM PanelMenu.Button por chamada).
        // Quase todas as extensões de painel usam essa caixa; o risco é ela
        // mudar de nome numa versão futura, por isso só declaramos suporte ao
        // GNOME 51 no metadata.json.
        Main.panel._leftBox.insert_child_at_index(this._menuBar, 0);

        // Esconde o botão Atividades / move o relógio (conforme preferências).
        this._panelLayout = new PanelLayout(this._settings);
    }

    disable() {
        this._panelLayout?.destroy();
        this._panelLayout = null;

        // destroy() remove a barra do painel e destrói os filhos (botões e
        // menus); os menus saem sozinhos do gerenciador de menus do painel.
        this._menuBar?.destroy();
        this._menuBar = null;

        this._settings?.disconnectObject(this);
        this._settings = null;
        setDebug(false);
    }
}
