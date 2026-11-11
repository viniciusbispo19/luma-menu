// SPDX-License-Identifier: GPL-3.0-or-later
// Ícone de bateria no estilo do MacBook, na barra de status do GNOME.
//
// Desenhado do zero com Cairo (nenhum arquivo ou símbolo da Apple):
//
//    ╭──────────────────╮
//    │ ▇▇▇▇▇▇▇▇▇▇       │▌   ← contorno a 50%, preenchimento proporcional
//    ╰──────────────────╯       à carga, com uma folga por dentro; "tampa"
//                                (terminal) à direita
//
// Cores do preenchimento:
//   normal → cor do texto da barra (funciona em tema claro e escuro)
//   carregando / cheia na tomada → verde, com um raio no meio
//   20% ou menos (sem carregar) → vermelho
//   modo de economia → amarelo
//
// O ícone original do GNOME (dentro do menu de status) é escondido enquanto
// o nosso está ativo e volta no destroy(). Sem bateria (desktop), nada muda.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PowerService} from './services/power.js';
import {formatBatteryStatus, formatPercent, T} from './strings.js';
import {TimeoutRegistry} from '../util.js';

const LOW_LEVEL = 20; // %
const GREEN = [48, 209, 88];
const RED = [255, 69, 58];
const YELLOW = [255, 214, 10];
/** Mudanças de carga/cor deslizam (ms). Nada roda parado. */
const TRANSITION_TIME = 250;
/** A dica aparece depois de o ponteiro parar sobre o ícone (ms). */
const TOOLTIP_DELAY = 400;

const BatteryDrawing = GObject.registerClass(
class LumaMenuBatteryDrawing extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'luma-battery-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Valores desenhados agora (animados) e os de destino.
        this._shown = {fill: 0, color: null};
        this._from = {fill: 0, color: null};
        this._to = {fill: 0, color: null, bolt: false};
        this._timeline = new Clutter.Timeline({actor: this, duration: TRANSITION_TIME});
        this._timeline.connect('new-frame', () => {
            const t = this._timeline.get_progress();
            this._shown.fill = this._from.fill + (this._to.fill - this._from.fill) * t;
            this._shown.color = mix(this._from.color, this._to.color, t);
            this.queue_repaint();
        });
        this.connect('destroy', () => this._timeline.stop());
    }

    /**
     * @param {number} fill - 0 a 1
     * @param {number[]|null} color - RGB, ou null = cor do texto da barra
     * @param {boolean} bolt - desenhar o raio (carregando/na tomada)
     */
    setState(fill, color, bolt) {
        const firstTime = this._to.color === null && this._shown.fill === 0;
        this._from = {fill: this._shown.fill, color: this._shown.color ?? color};
        this._to = {fill, color, bolt};
        if (firstTime || !St.Settings.get().enable_animations) {
            this._shown = {fill, color};
            this.queue_repaint();
            return;
        }
        this._timeline.stop();
        this._timeline.start();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = this.get_theme_node().get_foreground_color();
        const text = [fg.red, fg.green, fg.blue];

        // Proporção ~2:1. A tampa ocupa um pedacinho à direita.
        const capW = Math.max(1.5, w * 0.07);
        const bodyW = w - capW - 1;
        const bodyH = h;
        const radius = bodyH * 0.3;
        const line = 1;

        // Contorno semitransparente.
        roundedRect(cr, line / 2, line / 2, bodyW - line, bodyH - line, radius);
        cr.setSourceRGBA(text[0] / 255, text[1] / 255, text[2] / 255, 0.5);
        cr.setLineWidth(line);
        cr.stroke();

        // Tampa (terminal).
        const capH = bodyH * 0.38;
        roundedRect(cr, bodyW + 0.5, (bodyH - capH) / 2, capW, capH, capW / 2);
        cr.fill();

        // Preenchimento, com folga por dentro do contorno.
        const gap = 2;
        const innerW = bodyW - 2 * gap;
        const fillW = Math.max(innerW * this._shown.fill, this._shown.fill > 0 ? 2 : 0);
        if (fillW > 0) {
            const c = this._shown.color ?? text;
            roundedRect(cr, gap, gap, fillW, bodyH - 2 * gap, Math.max(0, radius - gap / 2));
            cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, 1);
            cr.fill();
        }

        if (this._to.bolt)
            drawBolt(cr, bodyW / 2, bodyH / 2, bodyH * 0.92, text);
        cr.$dispose();
    }
});

/** Retângulo de cantos arredondados (caminho do Cairo). */
function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Raio no centro: primeiro "recorta" um contorno (deixa transparente) para
 * o raio se destacar do preenchimento verde, depois pinta o raio.
 */
function drawBolt(cr, cx, cy, size, color) {
    // Pontos de um raio num quadrado 1×1 (desenho próprio).
    const pts = [[0.58, 0], [0.16, 0.56], [0.46, 0.56], [0.40, 1], [0.84, 0.42], [0.54, 0.42], [0.62, 0]];
    const w = size * 0.6;
    const path = () => {
        cr.newPath();
        pts.forEach(([px, py], i) => {
            const x = cx - w / 2 + px * w;
            const y = cy - size / 2 + py * size;
            if (i === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        });
        cr.closePath();
    };
    cr.save();
    path();
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.setLineWidth(2);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.stroke();
    cr.restore();
    path();
    cr.setSourceRGBA(color[0] / 255, color[1] / 255, color[2] / 255, 1);
    cr.fill();
}

function mix(a, b, t) {
    if (!a || !b)
        return b ?? a;
    return a.map((v, i) => v + (b[i] - v) * t);
}

/**
 * O indicador completo: [78%] [ícone], no lugar do ícone de bateria do
 * GNOME, com uma dica ao passar o ponteiro.
 */
export class BatteryIndicator {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._system = null; // indicador de energia do GNOME (escondido)
        this._hiddenByUs = false;
        this._timers = new TimeoutRegistry();
        this._tooltipTimer = 0;
        this._originalSubtitle = undefined;

        this.actor = new St.BoxLayout({
            style_class: 'luma-battery',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._label = new St.Label({
            style_class: 'luma-battery-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._label);
        this._drawing = new BatteryDrawing();
        this.actor.add_child(this._drawing);

        this._tooltip = new St.Label({style_class: 'luma-battery-tooltip', visible: false});
        Main.layoutManager.addTopChrome(this._tooltip);
        this.actor.connect('notify::hover', () => this._syncTooltip());

        this._power = new PowerService();
        this._power.connectObject('changed', () => this._sync(), this);
        settings.connectObject(
            'changed::battery-icon-enabled', () => this._sync(),
            'changed::battery-show-percentage', () => this._sync(),
            this);

        this._attach();
    }

    /**
     * O menu de status do GNOME cria os indicadores de forma assíncrona: se o
     * de energia ainda não existe, esperamos ele aparecer.
     */
    _attach() {
        const qs = Main.panel.statusArea.quickSettings;
        const system = qs?._system;
        if (!system) {
            qs?._indicators?.connectObject('child-added', () => {
                if (qs._system) {
                    qs._indicators.disconnectObject(this);
                    this._attach();
                }
            }, this);
            return;
        }
        this._system = system;
        const box = system.get_parent();
        box.insert_child_above(this.actor, system);
        // Se o GNOME mostrar o ícone dele de novo, escondemos (só enquanto o
        // nosso estiver visível).
        system.connectObject('notify::visible', () => {
            if (system.visible && this.actor.visible) {
                system.hide();
                this._hiddenByUs = true;
            }
        }, this);
        this._sync();
    }

    _sync() {
        const state = this._power.state;
        const enabled = this._settings.get_boolean('battery-icon-enabled');
        const show = Boolean(enabled && state && this._system);
        this.actor.visible = show;

        // Ícone do GNOME: escondido só quando o nosso aparece; volta senão.
        if (this._system) {
            if (show && this._system.visible) {
                this._system.hide();
                this._hiddenByUs = true;
            } else if (!show && this._hiddenByUs) {
                this._hiddenByUs = false;
                this._system.show();
            }
        }
        this._syncSubtitle(show ? state : null);
        if (!show)
            return;

        const fraction = Math.max(0, Math.min(1, state.percentage / 100));
        let color = null;
        if (state.pluggedIn)
            color = GREEN;
        else if (state.percentage <= LOW_LEVEL)
            color = RED;
        else if (state.powerSaver)
            color = YELLOW;
        this._drawing.setState(fraction, color, state.pluggedIn);

        this._label.visible = this._settings.get_boolean('battery-show-percentage');
        this._label.text = formatPercent(fraction);
        this.actor.accessible_name = `${T.battery}: ${formatBatteryStatus(state)}`;
        this._tooltip.text = formatBatteryStatus(state);
    }

    /** No menu de status do GNOME, o botão de energia ganha o mesmo texto. */
    _syncSubtitle(state) {
        const toggle = this._system?._systemItem?.powerToggle;
        if (!toggle || !('subtitle' in toggle))
            return;
        if (state) {
            if (this._originalSubtitle === undefined)
                this._originalSubtitle = toggle.subtitle;
            toggle.subtitle = formatBatteryStatus(state);
        } else if (this._originalSubtitle !== undefined) {
            toggle.subtitle = this._originalSubtitle;
            this._originalSubtitle = undefined;
        }
    }

    _syncTooltip() {
        this._timers.remove(this._tooltipTimer);
        this._tooltipTimer = 0;
        if (!this.actor.hover) {
            this._tooltip.hide();
            return;
        }
        this._tooltipTimer = this._timers.add(TOOLTIP_DELAY, () => {
            this._tooltipTimer = 0;
            const [x, y] = this.actor.get_transformed_position();
            const [w, h] = this.actor.get_transformed_size();
            this._tooltip.show();
            const [, tw] = this._tooltip.get_preferred_width(-1);
            const monitor = Main.layoutManager.primaryMonitor;
            const tx = Math.min(x + w / 2 - tw / 2, monitor.x + monitor.width - tw - 6);
            this._tooltip.set_position(Math.round(Math.max(monitor.x + 6, tx)), Math.round(y + h + 6));
        });
    }

    destroy() {
        this._timers.clear();
        this._settings.disconnectObject(this);
        this._power.disconnectObject(this);
        this._power.destroy();
        Main.panel.statusArea.quickSettings?._indicators?.disconnectObject(this);
        this._syncSubtitle(null);
        if (this._system) {
            this._system.disconnectObject(this);
            if (this._hiddenByUs)
                this._system.show();
        }
        this._hiddenByUs = false;
        Main.layoutManager.removeChrome(this._tooltip);
        this._tooltip.destroy();
        this.actor.destroy();
    }
}
