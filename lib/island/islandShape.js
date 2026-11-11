// SPDX-License-Identifier: GPL-3.0-or-later
// A forma preta do Isle que "sai" da barra, embaixo do relógio.
//
// Fechada, a forma tem exatamente o tamanho do relógio na barra (e fica
// escondida). Ao abrir, ela cresce com uma mola para BAIXO e para a
// ESQUERDA — a borda direita fica presa à borda direita do relógio — e
// ganha "ombros": curvas côncavas que ligam os lados da forma à borda de
// baixo da barra. Com a barra preta sólida, barra e forma parecem uma peça
// só, como no Isle.
//
// Por que desenhar com Cairo (St.DrawingArea) e não com CSS? O CSS do St
// só arredonda cantos para DENTRO; os ombros são curvas para FORA (côncavas),
// que o CSS não faz. Com Cairo desenhamos o contorno exato a cada quadro —
// e só enquanto a forma se move.
//
//      barra preta ──────────────╮▕ relógio ▏╭──────
//                                ╰╮          ╭╯   ← ombros
//                                 │  abas    │
//                                 │  página  │
//                                 ╰──────────╯    ← cantos grandes

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {BOUNCY, SMOOTH, Spring, SpringAnimator} from './spring.js';

/** Margem lateral do ator para caber os ombros (px lógicos). */
const SHOULDER_ROOM = 14;
/** Ombro e canto: fechada → aberta (px lógicos). */
const SHOULDER_CLOSED = 0;
const SHOULDER_OPEN = 14;
const CORNER_CLOSED = 6;
const CORNER_OPEN = 28;

// Troca de conteúdo: some rápido ao fechar; ao abrir espera a forma abrir
// espaço e então aparece (ease() já respeita "Reduzir animação").
const FADE_OUT_TIME = 100; // ms
const FADE_IN_TIME = 220; // ms
const FADE_IN_DELAY = 120; // ms

export const IslandShape = GObject.registerClass({
    Signals: {
        // Terminou de fechar (forma parada e escondida).
        'closed': {},
    },
}, class LumaMenuIslandShape extends St.Widget {
    _init() {
        super._init({
            name: 'lumaMenuIslandShape',
            style_class: 'luma-island-shape',
            reactive: true,
            visible: false,
        });

        this._isOpen = false;
        this._monitor = null;
        this._barHeight = 28;
        this._anchor = {right: 0, width: 160}; // o relógio na barra (x da tela)
        this._fadeTargets = [];

        // Fundo desenhado com Cairo.
        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', area => this._paint(area));
        this.add_child(this._canvas);

        // Conteúdo, recortado no retângulo do corpo da forma.
        this._clip = new St.Widget({clip_to_allocation: true});
        this.add_child(this._clip);
        this._content = null;

        this._width = new Spring(this._anchor.width);
        this._height = new Spring(this._barHeight);
        // Progresso 0 (fechada) → 1 (aberta): ombros e cantos, sem quique.
        this._progress = new Spring(0, SMOOTH);
        this._frame = {w: this._anchor.width, h: this._barHeight, p: 0};
        this._animator = new SpringAnimator(this,
            [this._width, this._height, this._progress],
            now => this._onFrame(now),
            () => this._onSettled());

        this._retargetLater = 0;
        this.connect('destroy', () => {
            this._animator.destroy();
            if (this._retargetLater)
                global.compositor.get_laters().remove(this._retargetLater);
            this._retargetLater = 0;
        });
    }

    // ----- Configuração -----------------------------------------------------------

    /**
     * @param {Clutter.Actor} content - abas + página (natural, alinhado à direita)
     * @param {Clutter.Actor[]} fadeTargets - partes que aparecem/somem suavemente
     */
    setContent(content, fadeTargets) {
        this._content = content;
        this._clip.add_child(content);
        this._fadeTargets = fadeTargets;
        // Conteúdo mudou de tamanho (outra página, mês com 6 semanas): se a
        // forma está aberta, ela acompanha.
        content.connect('queue-relayout', () => {
            if (this._isOpen)
                this._scheduleRetarget();
        });
    }

    /**
     * @param {object} monitor - Main.layoutManager.primaryMonitor
     * @param {number} barHeight - altura da barra
     */
    setGeometry(monitor, barHeight) {
        this._monitor = monitor;
        this._barHeight = barHeight;
        if (!this._isOpen)
            this._jumpToClosed();
    }

    /**
     * Onde está o relógio na barra (coordenadas da tela). A forma nasce dele.
     *
     * @param {number} x
     * @param {number} width
     */
    setAnchor(x, width) {
        this._anchor = {right: x + width, width};
        if (!this._isOpen)
            this._jumpToClosed();
    }

    get isOpen() {
        return this._isOpen;
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    open() {
        if (this._isOpen)
            return;
        this._isOpen = true;
        this.show();
        for (const actor of this._fadeTargets) {
            actor.remove_all_transitions();
            actor.opacity = 0;
            actor.ease({
                opacity: 255,
                delay: FADE_IN_DELAY,
                duration: FADE_IN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._retarget();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        for (const actor of this._fadeTargets) {
            actor.remove_all_transitions();
            actor.ease({
                opacity: 0,
                duration: FADE_OUT_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._retarget();
    }

    /** Para mola e fades (antes de tirar a forma do palco). */
    stopAnimations() {
        this._animator.stop();
        for (const actor of this._fadeTargets)
            actor.remove_all_transitions();
    }

    // ----- Tamanho ----------------------------------------------------------------

    _scheduleRetarget() {
        if (this._retargetLater)
            return;
        const laters = global.compositor.get_laters();
        // "Laters" rodam uma vez, logo antes do próximo quadro.
        this._retargetLater = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._retargetLater = 0;
            if (this._isOpen)
                this._retarget();
            return false;
        });
    }

    _retarget() {
        let w = this._anchor.width;
        let h = this._barHeight;
        if (this._isOpen && this._content) {
            [, w] = this._content.get_preferred_width(-1);
            [, h] = this._content.get_preferred_height(w);
            // Nunca mais estreita que o relógio, nem passa da tela.
            w = Math.max(w, this._anchor.width);
            if (this._monitor)
                w = Math.min(w, this._anchor.right - this._monitor.x - SHOULDER_ROOM);
        }
        this._width.setTarget(Math.round(w), this._isOpen ? BOUNCY : SMOOTH);
        this._height.setTarget(Math.round(h), this._isOpen ? BOUNCY : SMOOTH);
        this._progress.setTarget(this._isOpen ? 1 : 0);
        this._animator.kick();
    }

    _jumpToClosed() {
        this._width.jumpTo(this._anchor.width);
        this._height.jumpTo(this._barHeight);
        this._progress.jumpTo(0);
        this._onFrame(0);
    }

    _onFrame(now) {
        this._frame = {
            w: Math.max(1, Math.round(this._width.value(now))),
            h: Math.max(1, Math.round(this._height.value(now))),
            p: Math.min(1, Math.max(0, this._progress.value(now))),
        };
        if (this._monitor) {
            const x = this._anchor.right - this._frame.w - SHOULDER_ROOM;
            this.set_position(x, this._monitor.y);
        }
        this.queue_relayout();
        this._canvas.queue_repaint();
    }

    _onSettled() {
        if (!this._isOpen) {
            this.hide();
            this.emit('closed');
        }
    }

    vfunc_get_preferred_width(_forHeight) {
        const w = this._frame.w + 2 * SHOULDER_ROOM;
        return [w, w];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [this._frame.h, this._frame.h];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const {w, h} = this._frame;

        const full = new Clutter.ActorBox();
        full.set_size(box.x2 - box.x1, box.y2 - box.y1);
        this._canvas.allocate(full);

        // O recorte é o corpo da forma (sem os ombros).
        const body = new Clutter.ActorBox();
        body.set_origin(SHOULDER_ROOM, 0);
        body.set_size(w, h);
        this._clip.allocate(body);

        if (this._content) {
            // Conteúdo no tamanho natural, preso à DIREITA (onde está o
            // relógio) e ao topo: a forma vai revelando enquanto cresce.
            const [, cw] = this._content.get_preferred_width(-1);
            const [, ch] = this._content.get_preferred_height(cw);
            const child = new Clutter.ActorBox();
            child.set_origin(w - cw, 0);
            child.set_size(cw, ch);
            this._content.allocate(child);
        }
    }

    // ----- Desenho ----------------------------------------------------------------

    /** @param {St.DrawingArea} area */
    _paint(area) {
        const cr = area.get_context();
        const {w, h, p} = this._frame;
        const bar = this._barHeight;
        const left = SHOULDER_ROOM;
        const right = SHOULDER_ROOM + w;
        // Ombro só existe abaixo da barra; canto nunca maior que a forma.
        const s = Math.min(SHOULDER_CLOSED + (SHOULDER_OPEN - SHOULDER_CLOSED) * p,
            Math.max(0, h - bar));
        const r = Math.min(CORNER_CLOSED + (CORNER_OPEN - CORNER_CLOSED) * p,
            w / 2, h / 2);

        // Contorno no sentido horário (eixo y para baixo).
        cr.moveTo(left, 0);
        cr.lineTo(right, 0);
        cr.lineTo(right, bar);
        if (s > 0.5) {
            // Ombro direito: sai da borda de baixo da barra e curva para o lado.
            cr.lineTo(right + s, bar);
            cr.arcNegative(right + s, bar + s, s, 1.5 * Math.PI, Math.PI);
        }
        cr.lineTo(right, h - r);
        cr.arc(right - r, h - r, r, 0, 0.5 * Math.PI); // canto inferior direito
        cr.lineTo(left + r, h);
        cr.arc(left + r, h - r, r, 0.5 * Math.PI, Math.PI); // canto inferior esquerdo
        if (s > 0.5) {
            cr.lineTo(left, bar + s);
            // Ombro esquerdo.
            cr.arcNegative(left - s, bar + s, s, 0, -0.5 * Math.PI);
            cr.lineTo(left, bar);
        }
        cr.closePath();

        cr.setSourceRGBA(0, 0, 0, 1); // preto sólido do Isle
        cr.fill();
        cr.$dispose();
    }
});
