// SPDX-License-Identifier: GPL-3.0-or-later
// Extensão auxiliar, SÓ para desenvolvimento (não é publicada).
//
// O "modo inseguro" (unsafe mode) do GNOME Shell libera duas coisas por D-Bus:
//   - org.gnome.Shell.Eval: executar JavaScript dentro do Shell;
//   - org.gnome.Shell.Screenshot: tirar print sem ser um app autorizado.
// Com isso conseguimos inspecionar e testar a sessão aninhada pelo terminal
// (scripts/nested-eval.sh, scripts/nested-screenshot.sh).
//
// Segurança: o modo inseguro só é ligado se a variável LUMA_MENU_DEV=1 existir,
// e ela só é definida pelo scripts/dev-nested.sh. Na sua sessão normal esta
// extensão não faz nada (e nem fica ativada, pois o dconf da sessão aninhada
// é uma cópia separada).

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class LumaMenuDevTools extends Extension {
    enable() {
        if (GLib.getenv('LUMA_MENU_DEV') !== '1')
            return;

        this._previousUnsafeMode = global.context.unsafe_mode;
        global.context.unsafe_mode = true;
    }

    disable() {
        if (this._previousUnsafeMode === undefined)
            return;

        global.context.unsafe_mode = this._previousUnsafeMode;
        this._previousUnsafeMode = undefined;
    }
}
