// SPDX-License-Identifier: GPL-3.0-or-later
// Ajustes no painel do GNOME que a barra precisa: esconder o botão Atividades
// e (opcionalmente) levar o relógio para a direita, como no macOS.
//
// Regra: tudo que mudamos no painel é anotado e DESFEITO no destroy(), na
// mesma posição em que estava. Mudanças nas preferências valem na hora.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class PanelLayout {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._activitiesHiddenByUs = false;
        this._clockOrigin = null; // {parent, index} quando movemos o relógio

        settings.connectObject(
            'changed::hide-activities', () => this._syncActivities(),
            'changed::clock-position', () => this._syncClock(),
            this);
        this._syncActivities();
        this._syncClock();
    }

    // No GNOME 51 o botão Atividades contém os pontinhos das áreas de
    // trabalho; escondê-lo some com os dois — igual ao macOS.
    _syncActivities() {
        const container = Main.panel.statusArea.activities?.container;
        if (!container)
            return;
        const hide = this._settings.get_boolean('hide-activities');

        if (hide && container.visible && !this._activitiesHiddenByUs) {
            container.hide();
            this._activitiesHiddenByUs = true;
        } else if (!hide && this._activitiesHiddenByUs) {
            container.show();
            this._activitiesHiddenByUs = false;
        }
        // Se outra extensão (ex.: Just Perfection) já escondeu o botão, não
        // marcamos como "nosso" — e não o mostramos de volta no destroy().
    }

    _syncClock() {
        const container = Main.panel.statusArea.dateMenu?.container;
        if (!container)
            return;
        const toRight = this._settings.get_string('clock-position') === 'right';

        if (toRight && !this._clockOrigin) {
            const parent = container.get_parent();
            if (!parent)
                return;
            this._clockOrigin = {
                parent,
                index: parent.get_children().indexOf(container),
            };
            parent.remove_child(container);
            // Última posição da caixa da direita: depois do menu de status.
            Main.panel._rightBox.add_child(container);
        } else if (!toRight && this._clockOrigin) {
            this._restoreClock();
        }
    }

    _restoreClock() {
        const container = Main.panel.statusArea.dateMenu?.container;
        const {parent, index} = this._clockOrigin;
        this._clockOrigin = null;
        if (!container)
            return;
        container.get_parent()?.remove_child(container);
        parent.insert_child_at_index(container, Math.min(index, parent.get_n_children()));
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._activitiesHiddenByUs)
            Main.panel.statusArea.activities?.container.show();
        this._activitiesHiddenByUs = false;
        if (this._clockOrigin)
            this._restoreClock();
    }
}
