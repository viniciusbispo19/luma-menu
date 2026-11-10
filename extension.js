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

export default class LumaMenuExtension extends Extension {
    enable() {
        // A barra é um único ator (St.BoxLayout) com todos os títulos dentro.
        this._menuBar = new MenuBar(this.dir);

        // `_leftBox` é a caixa da esquerda do painel. O "_" indica que é
        // interno do Shell (não há API pública para inserir um ator qualquer
        // ali — `addToStatusArea` só aceita UM PanelMenu.Button por chamada).
        // Quase todas as extensões de painel usam essa caixa; o risco é ela
        // mudar de nome numa versão futura, por isso só declaramos suporte ao
        // GNOME 51 no metadata.json.
        Main.panel._leftBox.insert_child_at_index(this._menuBar, 0);

        this._hideActivitiesButton();
    }

    disable() {
        this._restoreActivitiesButton();

        // destroy() remove a barra do painel e destrói os filhos (botões e
        // menus); os menus saem sozinhos do gerenciador de menus do painel.
        this._menuBar?.destroy();
        this._menuBar = null;
    }

    // No GNOME 51 o botão "Atividades" contém os pontinhos das áreas de
    // trabalho, então escondê-lo some com os dois — igual ao macOS.
    // Por enquanto ele é sempre escondido; na Fase 8 vira uma opção.
    _hideActivitiesButton() {
        const activities = Main.panel.statusArea.activities;

        // Só restauramos depois o que NÓS escondemos: se outra extensão (ex.:
        // Just Perfection) já o tinha escondido, não mexemos nele no disable().
        this._activitiesHiddenByUs = Boolean(activities?.container.visible);
        if (this._activitiesHiddenByUs)
            activities.container.hide();
    }

    _restoreActivitiesButton() {
        if (this._activitiesHiddenByUs)
            Main.panel.statusArea.activities?.container.show();
        this._activitiesHiddenByUs = false;
    }
}
