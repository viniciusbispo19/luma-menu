// SPDX-License-Identifier: GPL-3.0-or-later
// Alertas do Isle, saindo de baixo do relógio no canto direito.
//
// Um alerta é uma forma pequena (IslandSurface, vidro fumê com mola) que desce
// da barra embaixo do relógio, mostra algo e volta para dentro dele. Dois tipos:
//
//   nível   — volume, brilho:  🔊 Volume  ▬▬▬▬▬▭▭▭  65%
//   mensagem — bateria, Caps Lock, Bluetooth, rede, foco, eventos:
//             🔋 Bateria fraca                         [Entrar] ×
//                Conecte o carregador
//
// Regras (como no Isle):
//   - um de cada vez; mensagens novas esperam numa FILA;
//   - níveis são "instantâneos": substituem o que estiver na tela e, se não
//     puderem aparecer agora, são descartados (velhos não interessam);
//   - o mesmo alerta (mesma chave) não se repete em pouco tempo;
//   - Não Perturbe silencia tudo, menos alertas urgentes (bateria em 10%);
//   - com uma janela em tela cheia, mensagens esperam e aparecem depois;
//   - ponteiro em cima segura o alerta; × ou clique fecha;
//   - a faixa da altura da barra não recebe cliques (o relógio e os ícones
//     continuam clicáveis por cima do alerta).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {IslandSurface} from './surface.js';
import {T, formatPercent} from './strings.js';
import {TimeoutRegistry} from '../util.js';

/** Níveis somem 1,5 s depois do último ajuste. */
const LEVEL_DURATION = 1500;
/** Mensagens comuns ficam 4 s (o ponteiro em cima segura). */
const MESSAGE_DURATION = 4000;
/** A barra de nível desliza até o valor novo (ms) — como o OSD do GNOME. */
const LEVEL_ANIMATION_TIME = 100;
/** O mesmo alerta não se repete dentro deste tempo (ms). */
const DEDUPE_WINDOW = 10000;
/** Cantos e ombros da forma do alerta (menor que o painel do relógio). */
const ALERT_CORNER = 22;
const ALERT_SHOULDER = 12;

export class AlertPresenter {
    /**
     * @param {Gio.Settings} settings
     * @param {BarLook} look - a cor da barra
     * @param {Function} getAnchor - () => {x, width}: o relógio na tela AGORA
     * @param {Function} canShow - () => boolean: pop-up do relógio fechado etc.
     */
    constructor(settings, look, getAnchor, canShow = () => true) {
        this._settings = settings;
        this._look = look;
        this._getAnchor = getAnchor;
        this._canShow = canShow;
        this._timers = new TimeoutRegistry();
        this._hideTimer = 0;
        this._current = null; // alerta na tela
        this._queue = [];
        this._recent = new Map(); // chave → quando apareceu (ms)
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this._surface = new IslandSurface({corner: ALERT_CORNER, shoulder: ALERT_SHOULDER});
        this._buildContent();
        this._surface.setContent(this._content, [this._row]);
        // O tamanho final só se sabe depois que o estilo (ícone maior das
        // mensagens, botão…) é aplicado: a forma acompanha cada mudança.
        this._content.connect('queue-relayout', () => this._surface.scheduleRetarget());
        this._surface.setTint(look.tint);
        this._surface.connect('closed', () => this._showNext());
        look.connectObject('changed', () => this._surface.setTint(look.tint), this);
        Main.layoutManager.addChrome(this._surface);

        // Saiu da tela cheia: mostra o que estava esperando.
        global.display.connectObject('in-fullscreen-changed', () => this._showNext(), this);
    }

    // ----- Construção -------------------------------------------------------------

    _buildContent() {
        this._content = new St.BoxLayout({
            style_class: 'luma-island-alert',
            orientation: Clutter.Orientation.VERTICAL,
        });
        // Faixa da altura da barra: vazia (ali aparece o relógio de verdade).
        this._barSpacer = new St.Widget();
        this._content.add_child(this._barSpacer);

        // Só a linha do alerta recebe o mouse (para "segurar" e clicar).
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
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => {
            const alert = this._current;
            if (alert?.kind !== 'message')
                return;
            alert.onActivate?.();
            this.dismiss();
        });
        this._row.add_action(click);
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
        this._subtitle = new St.Label({style_class: 'luma-island-alert-subtitle'});
        column.add_child(this._title);
        column.add_child(this._subtitle);
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

        this._action = new St.Button({
            style_class: 'luma-island-pill luma-island-alert-action',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._action.connect('clicked', () => {
            this._current?.onAction?.();
            this.dismiss();
        });
        this._row.add_child(this._action);

        this._close = new St.Button({
            style_class: 'luma-island-alert-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: T.close,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._close.connect('clicked', () => this.dismiss());
        this._row.add_child(this._close);
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

    // ----- Alertas de nível (volume, brilho) -------------------------------------

    /**
     * Mostra (ou atualiza) um alerta de nível. Instantâneo: passa na frente
     * de mensagens (que voltam para a fila).
     *
     * @param {object} alert
     * @param {string} alert.kind - 'volume', 'brightness', 'keyboard'
     * @param {Gio.Icon} alert.icon
     * @param {string} alert.title
     * @param {number} alert.level - 0 a maxLevel (1 = 100%)
     * @param {number} [alert.maxLevel] - 1, ou 1,5 com volume amplificado
     * @param {boolean} [alert.muted]
     * @param {string} [alert.mutedText] - "Mudo" no lugar do número
     * @returns {boolean} false = não deu para mostrar agora
     */
    showLevel({kind, icon, title, level, maxLevel = 1, muted = false, mutedText = ''}) {
        if (!this._canShow())
            return false;
        const sameKind = this._current?.kind === 'level' && this._current.levelKind === kind &&
            this._surface.isOpen;
        // Uma mensagem na tela volta para o começo da fila.
        if (this._current?.kind === 'message')
            this._queue.unshift(this._current);
        this._current = {kind: 'level', levelKind: kind};

        this._setMode('level');
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

        this._open();
        this._scheduleHide(LEVEL_DURATION);
        return true;
    }

    // ----- Mensagens ----------------------------------------------------------------

    /**
     * Enfileira uma mensagem.
     *
     * @param {object} m
     * @param {string} m.key - mesma chave = mesmo alerta (não repete)
     * @param {string} m.iconName
     * @param {string} m.title
     * @param {string} [m.subtitle]
     * @param {string} [m.actionLabel] - botão (ex.: "Entrar")
     * @param {Function} [m.onAction]
     * @param {Function} [m.onActivate] - clique no alerta
     * @param {number} [m.duration] - ms (0 = fica até fechar)
     * @param {boolean} [m.urgent] - aparece mesmo no Não Perturbe
     * @param {boolean} [m.dedupe] - false = pode repetir logo (Caps Lock)
     */
    showMessage(m) {
        const now = Date.now();
        if (m.dedupe !== false && now - (this._recent.get(m.key) ?? -Infinity) < DEDUPE_WINDOW)
            return;
        if (this._current?.key === m.key || this._queue.some(q => q.key === m.key))
            return;
        // Não Perturbe: só o urgente passa.
        if (!m.urgent && !this._notifications.get_boolean('show-banners'))
            return;
        this._queue.push({kind: 'message', duration: MESSAGE_DURATION, ...m});
        this._showNext();
    }

    /** Tira da fila/tela os alertas com esta chave (ex.: a rede voltou). */
    withdraw(key) {
        this._queue = this._queue.filter(q => q.key !== key);
        if (this._current?.key === key)
            this.dismiss();
    }

    _showNext() {
        if (this._current || this._surface.isOpen || this._surface.visible)
            return;
        if (this._queue.length === 0 || !this._canShow())
            return;
        // Tela cheia: espera (o "in-fullscreen-changed" chama de novo).
        if (Main.layoutManager.primaryMonitor?.inFullscreen)
            return;
        const m = this._queue.shift();
        this._current = m;
        this._recent.set(m.key, Date.now());

        this._setMode('message');
        this._icon.icon_name = m.iconName;
        this._title.text = m.title;
        this._subtitle.text = m.subtitle ?? '';
        this._subtitle.visible = Boolean(m.subtitle);
        this._action.visible = Boolean(m.actionLabel);
        this._action.label = m.actionLabel ?? '';

        this._open();
        this._scheduleHide(m.duration);
    }

    _setMode(mode) {
        const level = mode === 'level';
        this._level.visible = level;
        this._value.visible = level;
        this._subtitle.visible = !level;
        this._close.visible = !level;
        this._action.visible = false;
        if (level)
            this._row.remove_style_class_name('luma-island-alert-message');
        else
            this._row.add_style_class_name('luma-island-alert-message');
    }

    _open() {
        const anchor = this._surface.isOpen ? null : this._getAnchor();
        if (!anchor)
            return;
        // O alerta nasce do relógio, com a borda direita presa à dele.
        this._surface.setAnchor(anchor.x, anchor.width);
        const right = anchor.x + anchor.width;
        this._surface.open(() => {
            const [, w] = this._content.get_preferred_width(-1);
            const [, h] = this._content.get_preferred_height(w);
            return {x: right - w, width: w, height: h};
        });
    }

    _scheduleHide(duration = this._current?.duration ?? MESSAGE_DURATION) {
        this._timers.remove(this._hideTimer);
        this._hideTimer = 0;
        this._pendingDuration = duration;
        if (this._row.hover || !duration)
            return;
        this._hideTimer = this._timers.add(duration, () => {
            this._hideTimer = 0;
            this.dismiss();
        });
    }

    /** Fecha o alerta da tela (o próximo da fila vem depois). */
    dismiss() {
        this._timers.remove(this._hideTimer);
        this._hideTimer = 0;
        this._current = null;
        if (this._surface.isOpen)
            this._surface.close(); // "closed" chama _showNext
        else
            this._showNext();
    }

    /** Algo que impedia os alertas mudou (ex.: o pop-up fechou): tenta de novo. */
    flush() {
        this._showNext();
    }

    get isShowing() {
        return this._surface.isOpen;
    }

    destroy() {
        this._timers.clear();
        this._queue = [];
        this._look.disconnectObject(this);
        global.display.disconnectObject(this);
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
