// SPDX-License-Identifier: GPL-3.0-or-later
// Ajustes no painel do GNOME que a barra precisa: esconder o botão Atividades
// e (opcionalmente) levar o relógio para a direita, como no macOS.
//
// Regra: tudo que mudamos no painel é anotado e DESFEITO no destroy(), na
// mesma posição em que estava. Mudanças nas preferências valem na hora.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Se outra extensão mover o relógio de volta (ex.: a Just Perfection aplica
// a posição dela enquanto as extensões estão iniciando), reaplicamos a nossa
// — no máximo 3 vezes a cada 10 s, para nunca virar uma "briga" infinita com
// uma extensão que insista. Além disso, conferimos de novo 3 s após iniciar,
// quando as outras extensões já terminaram de carregar.
const MAX_CLOCK_REAPPLY = 3;
const CLOCK_REAPPLY_WINDOW = 10 * 1000 * 1000; // µs
const CLOCK_RECHECK_DELAY = 3000; // ms

export class PanelLayout {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._activitiesHiddenByUs = false;
        this._clockOrigin = null; // {parent, index} quando movemos o relógio
        this._clockReapplies = []; // instantes (µs) das últimas reaplicações
        this._clockIdleId = 0;
        this._clockRecheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOCK_RECHECK_DELAY, () => {
            this._clockRecheckId = 0;
            this._onClockMoved(true);
            return GLib.SOURCE_REMOVE;
        });

        // Se outra extensão tirar o relógio de onde o colocamos, reaplicamos.
        Main.panel.statusArea.dateMenu?.container.connectObject('parent-set',
            () => this._onClockMoved(), this);

        // O painel mostra o botão Atividades de novo ao trocar de modo de sessão
        // (ex.: ao desbloquear a tela). Se a preferência é escondê-lo, escondemos
        // de novo — com o mesmo limite contra "brigas" usado no relógio.
        this._activitiesReapplies = [];
        Main.panel.statusArea.activities?.container.connectObject('notify::visible',
            () => this._onActivitiesShown(), this);

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

    _onActivitiesShown() {
        const container = Main.panel.statusArea.activities?.container;
        if (!container?.visible || !this._settings.get_boolean('hide-activities'))
            return;
        const now = GLib.get_monotonic_time();
        this._activitiesReapplies = this._activitiesReapplies.filter(t => now - t < CLOCK_REAPPLY_WINDOW);
        if (this._activitiesReapplies.length >= MAX_CLOCK_REAPPLY)
            return;
        this._activitiesReapplies.push(now);
        container.hide();
        this._activitiesHiddenByUs = true;
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

    /**
     * @param {boolean} [force] - ignora o limite de reaplicações (checagem final)
     */
    _onClockMoved(force = false) {
        const container = Main.panel.statusArea.dateMenu?.container;
        const parent = container?.get_parent();
        if (!this._clockOrigin || !parent || parent === Main.panel._rightBox || this._clockIdleId)
            return;
        // Outra extensão moveu o relógio: a "origem" passa a ser onde ela o
        // quer (para devolvermos lá no destroy).
        this._clockOrigin = {parent, index: parent.get_children().indexOf(container)};
        const now = GLib.get_monotonic_time();
        this._clockReapplies = this._clockReapplies.filter(t => now - t < CLOCK_REAPPLY_WINDOW);
        if (!force && this._clockReapplies.length >= MAX_CLOCK_REAPPLY)
            return;
        this._clockReapplies.push(now);
        // Esperamos o ciclo atual terminar antes de mover de novo.
        this._clockIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._clockIdleId = 0;
            const c = Main.panel.statusArea.dateMenu?.container;
            if (this._clockOrigin && c?.get_parent() && c.get_parent() !== Main.panel._rightBox) {
                c.get_parent().remove_child(c);
                Main.panel._rightBox.add_child(c);
            }
            return GLib.SOURCE_REMOVE;
        });
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
        Main.panel.statusArea.dateMenu?.container.disconnectObject(this);
        Main.panel.statusArea.activities?.container.disconnectObject(this);
        if (this._clockIdleId)
            GLib.source_remove(this._clockIdleId);
        this._clockIdleId = 0;
        if (this._clockRecheckId)
            GLib.source_remove(this._clockRecheckId);
        this._clockRecheckId = 0;
        if (this._activitiesHiddenByUs)
            Main.panel.statusArea.activities?.container.show();
        this._activitiesHiddenByUs = false;
        if (this._clockOrigin)
            this._restoreClock();
    }
}
