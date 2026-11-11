// SPDX-License-Identifier: GPL-3.0-or-later
// Alertas do Isle, saindo do relógio no canto direito.
//
// Um alerta é uma forma pequena (a mesma IslandSurface do painel do relógio)
// que desce da barra embaixo do relógio, mostra algo por ~1,5 s e volta para
// dentro dele. Nesta fase: volume e brilho com a porcentagem.
//
//      barra ─────────────────────╮ qua, 11 de nov 14:05 ╭─
//                                 ╰╮                    ╭╯
//                                  │ 🔊 Volume      65% │
//                                  │ ▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭    │
//                                  ╰────────────────────╯
//
// Regras (como no Isle):
//   - o mesmo alerta, atualizado várias vezes seguidas (você segurando a
//     tecla de volume), NÃO reabre nem pisca: só a barra anda e o número muda;
//   - some 1,5 s depois do ÚLTIMO ajuste; com o ponteiro em cima, espera;
//   - a faixa da altura da barra não recebe cliques (o relógio e os ícones
//     continuam clicáveis por cima do alerta).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {IslandSurface} from './surface.js';
import {formatPercent} from './strings.js';
import {TimeoutRegistry} from '../util.js';

/** Quanto tempo o alerta fica depois do último ajuste (ms). */
const HIDE_DELAY = 1500;
/** A barra de nível desliza até o valor novo (ms) — como o OSD do GNOME. */
const LEVEL_ANIMATION_TIME = 100;
/** Cantos e ombros da forma do alerta (menor que o painel do relógio). */
const ALERT_CORNER = 22;
const ALERT_SHOULDER = 12;

export class AlertPresenter {
    /**
     * @param {Gio.Settings} settings
     * @param {BarLook} look - a cor da barra
     * @param {Function} getAnchor - () => {x, width}: o relógio na tela AGORA
     *   (medido na hora: ele muda de tamanho e de lugar, ex.: quando a
     *   temperatura aparece)
     */
    constructor(settings, look, getAnchor) {
        this._settings = settings;
        this._look = look;
        this._getAnchor = getAnchor;
        this._timers = new TimeoutRegistry();
        this._hideTimer = 0;
        this._current = null; // tipo do alerta na tela ('volume', 'brightness'…)

        this._surface = new IslandSurface({corner: ALERT_CORNER, shoulder: ALERT_SHOULDER});
        this._buildContent();
        this._surface.setContent(this._content, [this._row]);
        this._surface.setTint(look.tint);
        look.connectObject('changed', () => this._surface.setTint(look.tint), this);
        Main.layoutManager.addChrome(this._surface);
    }

    _buildContent() {
        this._content = new St.BoxLayout({
            style_class: 'luma-island-alert',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // Faixa da altura da barra: vazia (ali aparece o relógio de verdade).
        this._barSpacer = new St.Widget();
        this._content.add_child(this._barSpacer);

        // Só a linha do alerta recebe o mouse (para "segurar" o alerta).
        this._row = new St.BoxLayout({
            style_class: 'luma-island-alert-row',
            reactive: true,
            track_hover: true,
        });
        this._row.connect('notify::hover', () => {
            if (this._row.hover)
                this._timers.remove(this._hideTimer);
            else if (this._current)
                this._scheduleHide();
        });
        this._content.add_child(this._row);

        this._icon = new St.Icon({
            style_class: 'luma-island-alert-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._row.add_child(this._icon);

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'luma-island-alert-text',
        });
        this._row.add_child(column);
        this._title = new St.Label({style_class: 'luma-island-alert-title'});
        column.add_child(this._title);
        // A mesma barra do OSD do GNOME: acima de 100% (volume amplificado)
        // ela pinta a parte extra com outra cor.
        this._level = new BarLevel({style_class: 'luma-island-level'});
        column.add_child(this._level);

        // Largura fixa e dígitos tabulares: o número não faz a forma tremer.
        this._value = new St.Label({
            style_class: 'luma-island-alert-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._row.add_child(this._value);
    }

    /**
     * @param {number} barHeight
     * @param {object} monitor
     * @param {number} monitorIndex
     */
    setGeometry(barHeight, monitor, monitorIndex) {
        this._barSpacer.height = barHeight;
        this._surface.setGeometry(monitor, monitorIndex, barHeight);
    }

    /**
     * Mostra (ou atualiza) um alerta de nível: volume, brilho…
     *
     * @param {object} alert
     * @param {string} alert.kind - 'volume', 'brightness', 'keyboard'
     * @param {Gio.Icon} alert.icon
     * @param {string} alert.title
     * @param {number} alert.level - 0 a maxLevel (1 = 100%)
     * @param {number} [alert.maxLevel] - 1, ou 1,5 com volume amplificado
     * @param {boolean} [alert.muted]
     * @param {string} [alert.mutedText] - "Mudo" no lugar do número
     */
    showLevel({kind, icon, title, level, maxLevel = 1, muted = false, mutedText = ''}) {
        const sameKind = this._current === kind && this._surface.isOpen;
        this._current = kind;

        this._icon.gicon = icon;
        this._title.text = title;
        this._level.maximum_value = Math.max(1, maxLevel);
        const target = muted ? 0 : Math.max(0, level);
        if (sameKind) {
            // Mesmo alerta: só a barra desliza até o valor novo.
            this._level.ease_property('value', target, {
                duration: LEVEL_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._level.remove_transition('value');
            this._level.value = target;
        }

        // "Mostrar porcentagem" desligado: some só o número (a barra fica).
        const showNumber = this._settings.get_boolean('osd-show-percentage');
        this._value.visible = showNumber || muted;
        this._value.text = muted ? mutedText : formatPercent(level);
        // Passou de 100% (volume amplificado): o número ganha destaque.
        if (!muted && level > 1.001)
            this._value.add_style_class_name('luma-island-alert-over');
        else
            this._value.remove_style_class_name('luma-island-alert-over');

        const anchor = this._surface.isOpen ? null : this._getAnchor();
        if (anchor) {
            // O alerta nasce do relógio, com a borda direita presa à dele.
            this._surface.setAnchor(anchor.x, anchor.width);
            const right = anchor.x + anchor.width;
            this._surface.open(() => {
                const [, w] = this._content.get_preferred_width(-1);
                const [, h] = this._content.get_preferred_height(w);
                return {x: right - w, width: w, height: h};
            });
        }
        this._scheduleHide();
    }

    _scheduleHide() {
        this._timers.remove(this._hideTimer);
        if (this._row.hover)
            return;
        this._hideTimer = this._timers.add(HIDE_DELAY, () => {
            this._hideTimer = 0;
            this.dismiss();
        });
    }

    /** Some com o alerta (ex.: o painel do relógio vai abrir). */
    dismiss() {
        this._timers.remove(this._hideTimer);
        this._current = null;
        this._surface.close();
    }

    get isShowing() {
        return this._surface.isOpen;
    }

    destroy() {
        this._timers.clear();
        this._look.disconnectObject(this);
        this._level.remove_transition('value');
        this._surface.stopAnimations();
        Main.layoutManager.removeChrome(this._surface);
        this._surface.destroy();
    }
}

/**
 * Nome do ícone (ex.: "audio-volume-high-symbolic") de um Gio.Icon.
 *
 * @param {Gio.Icon} icon
 * @returns {string}
 */
export function iconName(icon) {
    if (icon instanceof Gio.ThemedIcon)
        return icon.get_names()[0] ?? '';
    return icon?.to_string?.() ?? '';
}
