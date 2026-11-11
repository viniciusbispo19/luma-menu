// SPDX-License-Identifier: GPL-3.0-or-later
// A "superfície" do Isle: a forma de vidro fumê que SAI da barra.
//
// Usada em dois lugares:
//   - pelo relógio (island.js): a forma tem conteúdo dentro (abas + página);
//   - pelos menus da barra (popup.js): a forma é o FUNDO atrás do conteúdo do
//     menu, e o conteúdo vai sendo revelado conforme ela cresce.
//
// Fechada, a forma tem o tamanho do título/relógio na barra (e fica
// escondida). Ao abrir, ela cresce com uma mola até o tamanho-alvo e ganha
// "ombros": curvas côncavas que a ligam à borda de baixo da barra.
//
// Visual (igual à barra, para as duas parecerem uma peça só):
//   1. desfoque: uma cópia do papel de parede, desfocada (como o desfoque
//      estático do Blur my Shell no painel), recortada no formato da forma
//      por uma máscara GLSL (shapeMask.js);
//   2. por cima, a "tinta": preto fumê (barra preta) ou a cor da barra do tema;
//   3. a faixa da altura da barra NÃO é pintada: ali aparece a própria barra.
//
//      barra ─────────────╮▕ título ▏╭────────
//                         ╰╮         ╭╯   ← ombros
//                          │ conteúdo│
//                          ╰─────────╯    ← cantos arredondados
//
// O desfoque só existe enquanto a forma está na tela: ao fechar, o fundo
// desfocado (do tamanho do monitor) é destruído e a memória volta.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {ShapeMask} from './shapeMask.js';
import {BOUNCY, SMOOTH, Spring, SpringAnimator} from './spring.js';

/**
 * Área do desfoque. NÃO usa clip_to_allocation: o recorte cortaria a cópia do
 * papel de parede ANTES de ela ser desfocada, e o desfoque "enxergaria"
 * transparência além da borda (a forma ficaria mais clara nos cantos). Em vez
 * disso, só declara que pinta dentro da própria área — o que dá o tamanho
 * certo à textura da máscara — e a máscara corta o resto.
 */
const BlurArea = GObject.registerClass(
class LumaMenuIslandBlurArea extends St.Widget {
    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }
});

/** Margem lateral do ator para caber os ombros (px lógicos). */
const SHOULDER_ROOM = 16;
/** Desfoque: o mesmo brilho do Blur my Shell no painel (0,6). */
const BLUR_RADIUS = 60;
const BLUR_BRIGHTNESS = 0.6;

// Troca de conteúdo: some rápido ao fechar; ao abrir espera a forma abrir
// espaço e então aparece (ease() já respeita "Reduzir animação").
const FADE_OUT_TIME = 100; // ms
const FADE_IN_TIME = 220; // ms
const FADE_IN_DELAY = 120; // ms

export const IslandSurface = GObject.registerClass({
    Signals: {
        // Cada quadro da animação (os menus recortam o conteúdo por ele).
        'frame': {},
        // A mola parou (aberta ou fechada).
        'settled': {},
        // Terminou de fechar (forma parada e escondida).
        'closed': {},
    },
}, class LumaMenuIslandSurface extends St.Widget {
    /**
     * @param {object} params
     * @param {number} params.corner - raio dos cantos de baixo, aberta
     * @param {number} params.shoulder - raio dos ombros, aberta
     * @param {boolean} [params.reactive] - recebe cliques (a do relógio)
     */
    _init({corner, shoulder, reactive = false}) {
        super._init({
            style_class: 'luma-island-surface',
            reactive,
            visible: false,
        });

        this._cornerOpen = corner;
        this._shoulderOpen = shoulder;
        this._isOpen = false;
        this._monitor = null;
        this._monitorIndex = 0;
        this._barHeight = 28;
        this._anchor = {x: 0, width: 100}; // título/relógio na barra (tela)
        this._target = null; // () => {x, width, height} do corpo aberto
        this._tint = [0, 0, 0, 0.85];
        this._fadeTargets = [];
        this._content = null;

        // 1. Desfoque (criado só enquanto visível) dentro de um recorte.
        this._blurClip = new BlurArea();
        this._mask = new ShapeMask();
        this._blurClip.add_effect(this._mask);
        this.add_child(this._blurClip);
        this._blurWidget = null;
        this._bgManager = null;

        // 2. A tinta e os ombros, desenhados com Cairo.
        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', area => this._paint(area));
        this.add_child(this._canvas);

        // 3. Conteúdo (só a superfície do relógio tem).
        this._clip = new St.Widget({clip_to_allocation: true});
        this.add_child(this._clip);

        // Molas: borda esquerda, largura e altura do corpo; progresso 0 → 1
        // para cantos e ombros (sem quique).
        this._x = new Spring(0);
        this._width = new Spring(100);
        this._height = new Spring(this._barHeight);
        this._progress = new Spring(0, SMOOTH);
        this._frame = {x: 0, w: 100, h: this._barHeight, p: 0};
        this._animator = new SpringAnimator(this,
            [this._x, this._width, this._height, this._progress],
            now => this._onFrame(now),
            () => this._onSettled());

        this._retargetLater = 0;
        this.connect('destroy', () => {
            this._animator.destroy();
            if (this._retargetLater)
                global.compositor.get_laters().remove(this._retargetLater);
            this._retargetLater = 0;
            this._destroyBlur();
        });
    }

    // ----- Configuração -----------------------------------------------------------

    /**
     * @param {Clutter.Actor} content - preso à DIREITA do corpo e ao topo
     * @param {Clutter.Actor[]} fadeTargets - partes que aparecem/somem suavemente
     */
    setContent(content, fadeTargets = []) {
        this._content = content;
        this._clip.add_child(content);
        this._fadeTargets = fadeTargets;
    }

    /**
     * @param {object} monitor - Main.layoutManager.monitors[i]
     * @param {number} monitorIndex
     * @param {number} barHeight
     */
    setGeometry(monitor, monitorIndex, barHeight) {
        const changed = this._monitorIndex !== monitorIndex;
        this._monitor = monitor;
        this._monitorIndex = monitorIndex;
        this._barHeight = barHeight;
        if (changed)
            this._destroyBlur();
        if (!this._isOpen && !this.visible)
            this._jumpToClosed();
    }

    /** De onde a forma nasce: o título/relógio na barra (x da tela). */
    setAnchor(x, width) {
        // Um ator ainda sem posição na tela devolve NaN: ignoramos.
        if (!Number.isFinite(x) || !Number.isFinite(width))
            return;
        this._anchor = {x, width};
        // Só "pula" se estiver escondida: fechando no meio da animação, a
        // mola continua de onde está.
        if (!this._isOpen && !this.visible)
            this._jumpToClosed();
    }

    /** @param {number[]} rgba - cor da tinta (0–255, 0–255, 0–255, 0–1) */
    setTint(rgba) {
        this._tint = rgba;
        this._canvas.queue_repaint();
    }

    get isOpen() {
        return this._isOpen;
    }

    /** Retângulo atual do corpo, em coordenadas da tela. */
    get bodyRect() {
        const y = this._monitor?.y ?? 0;
        return {x: this._frame.x, y, width: this._frame.w, height: this._frame.h};
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    /**
     * @param {Function} target - () => {x, width, height}: corpo aberto (x da
     *   tela; altura contada do topo da tela, incluindo a barra)
     */
    open(target) {
        this._target = target;
        if (this._isOpen) {
            this.retarget();
            return;
        }
        this._isOpen = true;
        this._ensureBlur();
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
        this.retarget();
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
        this.retarget();
    }

    /** Para mola e fades (antes de tirar a forma do palco). */
    stopAnimations() {
        this._animator.stop();
        for (const actor of this._fadeTargets)
            actor.remove_all_transitions();
    }

    // ----- Tamanho ----------------------------------------------------------------

    /** O conteúdo mudou de tamanho: recalcula no próximo quadro. */
    scheduleRetarget() {
        if (this._retargetLater || !this._isOpen)
            return;
        const laters = global.compositor.get_laters();
        // "Laters" rodam uma vez, logo antes do próximo quadro.
        this._retargetLater = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._retargetLater = 0;
            if (this._isOpen)
                this.retarget();
            return false;
        });
    }

    retarget() {
        let {x, width} = this._anchor;
        let height = this._barHeight;
        if (this._isOpen && this._target) {
            const t = this._target();
            // Alvo ainda sem medidas válidas (menu acabando de abrir): por
            // ora fica no título; o "notify::allocation" chama de novo.
            if (t && [t.x, t.width, t.height].every(Number.isFinite)) {
                ({x, width, height} = t);
                // Nunca sai da tela (os ombros também precisam caber): perto
                // da borda, a forma encurta em vez de se deslocar.
                if (this._monitor) {
                    const minX = this._monitor.x + SHOULDER_ROOM;
                    const maxRight = this._monitor.x + this._monitor.width;
                    if (x < minX) {
                        width -= minX - x;
                        x = minX;
                    }
                    width = Math.min(width, maxRight - x);
                }
            }
        }
        const config = this._isOpen ? BOUNCY : SMOOTH;
        this._x.setTarget(Math.round(x), config);
        this._width.setTarget(Math.round(width), config);
        this._height.setTarget(Math.round(height), config);
        this._progress.setTarget(this._isOpen ? 1 : 0);
        this._animator.kick();
    }

    _jumpToClosed() {
        this._x.jumpTo(this._anchor.x);
        this._width.jumpTo(this._anchor.width);
        this._height.jumpTo(this._barHeight);
        this._progress.jumpTo(0);
        this._onFrame(0);
    }

    _onFrame(now) {
        this._frame = {
            x: Math.round(this._x.value(now)),
            w: Math.max(1, Math.round(this._width.value(now))),
            h: Math.max(1, Math.round(this._height.value(now))),
            p: Math.min(1, Math.max(0, this._progress.value(now))),
        };
        if (this._monitor)
            this.set_position(this._frame.x - SHOULDER_ROOM, this._monitor.y);
        // Sem altura abaixo da barra, o desfoque some: o efeito de máscara não
        // pode criar uma textura de altura 0 (o Cogl reclama).
        this._blurClip.visible = this._frame.h - this._barHeight >= 1;
        this._syncBlurPosition();
        this._syncMask();
        this.queue_relayout();
        this._canvas.queue_repaint();
        this.emit('frame');
    }

    _onSettled() {
        this.emit('settled');
        if (!this._isOpen) {
            this.hide();
            // Fechada não precisa do fundo desfocado (do tamanho do monitor).
            this._destroyBlur();
            this.emit('closed');
        }
    }

    /** Ombro e canto do quadro atual, sem passar do tamanho da forma. */
    _radii() {
        const {w, h, p} = this._frame;
        const below = Math.max(0, h - this._barHeight);
        const shoulder = Math.min(this._shoulderOpen * p, below);
        const corner = Math.min(4 + (this._cornerOpen - 4) * p, w / 2, below);
        return {shoulder, corner};
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
        const bar = this._barHeight;
        const width = box.x2 - box.x1;

        const full = new Clutter.ActorBox();
        full.set_size(width, h);
        this._canvas.allocate(full);

        // Desfoque: só abaixo da barra (a barra já tem o dela).
        const blur = new Clutter.ActorBox();
        blur.set_origin(0, bar);
        blur.set_size(width, Math.max(0, h - bar));
        // O recorte aloca o fundo desfocado sozinho (tamanho fixo do monitor,
        // deslocado por translation_x/y para ficar parado na tela).
        this._blurClip.allocate(blur);

        // Conteúdo: o corpo inteiro, inclusive a faixa da barra.
        const body = new Clutter.ActorBox();
        body.set_origin(SHOULDER_ROOM, 0);
        body.set_size(w, h);
        this._clip.allocate(body);
        if (this._content) {
            // Tamanho natural, preso à DIREITA (onde está o relógio) e ao
            // topo: a forma vai revelando enquanto cresce.
            const [, cw] = this._content.get_preferred_width(-1);
            const [, ch] = this._content.get_preferred_height(cw);
            const child = new Clutter.ActorBox();
            child.set_origin(w - cw, 0);
            child.set_size(cw, ch);
            this._content.allocate(child);
        }
    }

    // ----- Desfoque ---------------------------------------------------------------

    _ensureBlur() {
        if (this._blurWidget || !this._monitor)
            return;
        // Mesma receita do desfoque da tela de bloqueio do GNOME
        // (ui/unlockDialog.js): um widget do tamanho do monitor com o papel
        // de parede (BackgroundManager) e o efeito de desfoque.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._blurWidget = new St.Widget({
            width: this._monitor.width,
            height: this._monitor.height,
            effect: new Shell.BlurEffect({
                radius: BLUR_RADIUS * scale,
                brightness: BLUR_BRIGHTNESS,
            }),
        });
        this._bgManager = new Background.BackgroundManager({
            container: this._blurWidget,
            monitorIndex: this._monitorIndex,
            controlPosition: false,
        });
        this._blurClip.add_child(this._blurWidget);
        this._syncBlurPosition();
    }

    _destroyBlur() {
        this._bgManager?.destroy();
        this._bgManager = null;
        this._blurWidget?.destroy();
        this._blurWidget = null;
    }

    /** O papel de parede desfocado fica PARADO na tela, alinhado ao monitor. */
    _syncBlurPosition() {
        if (!this._blurWidget || !this._monitor)
            return;
        const surfaceX = this._frame.x - SHOULDER_ROOM;
        this._blurWidget.translation_x = this._monitor.x - surfaceX;
        this._blurWidget.translation_y = -this._barHeight;
    }

    _syncMask() {
        const {shoulder, corner} = this._radii();
        this._mask.setShape({
            width: this._frame.w + 2 * SHOULDER_ROOM,
            height: Math.max(1, this._frame.h - this._barHeight),
            left: SHOULDER_ROOM,
            right: SHOULDER_ROOM + this._frame.w,
            shoulder,
            corner,
        });
        this._blurClip.queue_redraw();
    }

    // ----- Desenho ----------------------------------------------------------------

    /** @param {St.DrawingArea} area */
    _paint(area) {
        const cr = area.get_context();
        const {w, h} = this._frame;
        const bar = this._barHeight;
        if (h > bar + 0.5) {
            const left = SHOULDER_ROOM;
            const right = SHOULDER_ROOM + w;
            const {shoulder: s, corner: r} = this._radii();

            // Contorno no sentido horário (eixo y para baixo), começando na
            // borda de baixo da barra — a faixa da barra não é pintada.
            cr.moveTo(left - s, bar);
            cr.lineTo(right + s, bar);
            if (s > 0.5) // ombro direito
                cr.arcNegative(right + s, bar + s, s, 1.5 * Math.PI, Math.PI);
            cr.lineTo(right, h - r);
            cr.arc(right - r, h - r, r, 0, 0.5 * Math.PI); // canto inf. direito
            cr.lineTo(left + r, h);
            cr.arc(left + r, h - r, r, 0.5 * Math.PI, Math.PI); // canto inf. esquerdo
            cr.lineTo(left, bar + s);
            if (s > 0.5) // ombro esquerdo
                cr.arcNegative(left - s, bar + s, s, 0, -0.5 * Math.PI);
            cr.closePath();

            const [red, green, blue, alpha] = this._tint;
            cr.setSourceRGBA(red / 255, green / 255, blue / 255, alpha);
            cr.fill();
        }
        cr.$dispose();
    }
});
