// SPDX-License-Identifier: GPL-3.0-or-later
// Troca o "OSD" do GNOME (a caixa de volume/brilho no meio da tela) pelo
// alerta que sai do relógio.
//
// Quem mostra o OSD:
//   - teclas de volume/brilho/brilho do teclado: o gsd-media-keys chama
//     org.gnome.Shell.ShowOSD → Main.osdWindowManager.showOne(...);
//   - rolar o mouse no ícone de volume: volume.js → showAll(...);
//   - teclas de brilho da tela: brightnessManager.js → show(...).
//
// Interceptamos os três métodos com o InjectionManager do GNOME (a forma
// oficial de "remendar" o Shell numa extensão; clear() devolve os originais
// no disable()). Volume e brilho viram alerta; todo o resto (e os casos em
// que não podemos mostrar o alerta) segue para o OSD original — nunca
// aparecem dois indicadores.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {iconName} from '../alerts.js';
import {T} from '../strings.js';

export class OsdOverride {
    /**
     * @param {Gio.Settings} settings
     * @param {AlertPresenter} presenter
     * @param {Function} canShow - () => boolean: o alerta pode aparecer agora?
     */
    constructor(settings, presenter, canShow) {
        this._settings = settings;
        this._presenter = presenter;
        this._canShow = canShow;
        this._injections = new InjectionManager();

        const self = this;
        const osd = Main.osdWindowManager;
        this._injections.overrideMethod(osd, 'showAll', original =>
            function(icon, label, level, maxLevel) {
                if (!self._handle(icon, label, level, maxLevel))
                    original.call(this, icon, label, level, maxLevel);
            });
        this._injections.overrideMethod(osd, 'showOne', original =>
            function(monitorIndex, icon, label, level, maxLevel) {
                if (!self._handle(icon, label, level, maxLevel))
                    original.call(this, monitorIndex, icon, label, level, maxLevel);
            });
        this._injections.overrideMethod(osd, 'show', original =>
            function(icon, label, levels) {
                // Brilho por monitor: usamos o do monitor principal (ou o
                // primeiro que vier).
                const entry = levels?.[Main.layoutManager.primaryIndex] ??
                    Object.values(levels ?? {})[0];
                if (!entry || !self._handle(icon, label, entry.level, entry.maxLevel))
                    original.call(this, icon, label, levels);
            });
    }

    /** @returns {boolean} true = viramos alerta (o OSD original não aparece) */
    _handle(icon, label, level, maxLevel) {
        if (level === null || level === undefined || !icon)
            return false;
        const name = iconName(icon);
        let kind, title;
        if (name.startsWith('audio-volume')) {
            kind = 'volume';
            title = T.volume;
        } else if (name.startsWith('display-brightness')) {
            kind = 'brightness';
            title = T.brightness;
        } else if (name.startsWith('keyboard-brightness')) {
            kind = 'keyboard';
            title = T.keyboardBrightness;
        } else {
            return false; // microfone, touchpad… seguem para o OSD do GNOME
        }

        const key = kind === 'volume' ? 'alert-volume' : 'alert-brightness';
        if (!this._settings.get_boolean(key) || !this._canShow())
            return false;

        const shown = this._presenter.showLevel({
            kind,
            icon,
            // O GNOME às vezes manda o nome do dispositivo (ex.: o fone).
            title: label ? `${title} · ${label}` : title,
            level,
            maxLevel: maxLevel > 0 ? maxLevel : 1,
            muted: name.includes('muted'),
            mutedText: T.muted,
        });
        if (!shown)
            return false;
        // Se o OSD do GNOME estava na tela (de antes), some com ele.
        Main.osdWindowManager.hideAll();
        return true;
    }

    destroy() {
        this._injections.clear();
    }
}
