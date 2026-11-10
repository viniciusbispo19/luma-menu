// SPDX-License-Identifier: GPL-3.0-or-later
// Luma Menu — ponto de entrada da extensão.
//
// O GNOME Shell importa este arquivo e cria UMA instância da classe exportada
// como `default`. Depois ele chama enable() e disable() quantas vezes quiser.
//
// Regra de ouro do extensions.gnome.org: NADA é criado no construtor ou no
// nível do módulo; tudo nasce no enable() e tudo é destruído no disable().
//
// Por que "session-modes": ["user", "unlock-dialog"] no metadata.json?
// Por padrão o GNOME DESATIVA as extensões ao bloquear a tela. Isso destruiria
// o nosso Registrar (camada B), e os apps Qt/Electron — que só registram seus
// menus quando abrem — perderiam os menus a cada bloqueio. Então, durante o
// bloqueio, a extensão continua ativa, mas mantém VIVO APENAS o Registrar
// (um serviço D-Bus, sem nenhuma interface na tela). A barra, os atalhos e
// as mudanças no painel são destruídos ao bloquear e recriados ao desbloquear.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MenuBar} from './lib/menuBar.js';
import {PanelLayout} from './lib/panelLayout.js';
import {Registrar} from './lib/sources/registrar.js';
import {setDebug} from './lib/util.js';

export default class LumaMenuExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setDebug(this._settings.get_boolean('debug'));
        this._settings.connectObject(
            'changed::debug', () => setDebug(this._settings.get_boolean('debug')),
            'changed::enable-registrar', () => this._syncRegistrar(),
            this);

        this._registrar = null;
        this._syncRegistrar();

        // Bloqueio/desbloqueio de tela chegam como mudança de "modo de sessão".
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._destroyUi();
        this._registrar?.destroy();
        this._registrar = null;
        this._settings?.disconnectObject(this);
        this._settings = null;
        setDebug(false);
    }

    /** Liga/desliga o Registrar (camada B) conforme a preferência, ao vivo. */
    _syncRegistrar() {
        const wanted = this._settings.get_boolean('enable-registrar');
        if (wanted && !this._registrar) {
            this._registrar = new Registrar();
        } else if (!wanted && this._registrar) {
            this._registrar.destroy();
            this._registrar = null;
        }
        this._menuBar?.setRegistrar(this._registrar);
    }

    _syncSessionMode() {
        if (Main.sessionMode.isLocked)
            this._destroyUi();
        else
            this._createUi();
    }

    _createUi() {
        if (this._menuBar)
            return;

        // A barra é um único ator (St.BoxLayout) com todos os títulos dentro.
        this._menuBar = new MenuBar(this, this._registrar);

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

    _destroyUi() {
        this._panelLayout?.destroy();
        this._panelLayout = null;

        // destroy() remove a barra do painel e destrói os filhos (botões e
        // menus); os menus saem sozinhos do gerenciador de menus do painel.
        this._menuBar?.destroy();
        this._menuBar = null;
    }
}
