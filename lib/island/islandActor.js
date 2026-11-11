// SPDX-License-Identifier: GPL-3.0-or-later
// O ator da ilha: a "pílula/notch" escura no centro do topo da tela.
//
// Estrutura:
//
//   LumaMenuIsland (St.Widget, fundo + cantos + sombra)
//   ├── probe     (invisível; só para lermos a cor de fundo dos menus do tema)
//   └── content   (corta o que passar da borda durante a animação)
//       ├── closedView  (hora e data — ilha fechada)
//       └── openView    (abas + página — ilha aberta)
//
// O tamanho da ilha é animado por duas molas (largura e altura). A cada
// quadro, a ilha informa o novo tamanho como "tamanho preferido" e pede um
// novo layout; o uiGroup do Shell (que posiciona os atores de chrome) então
// a aloca com esse tamanho. Os dois conteúdos NÃO são redimensionados a cada
// quadro (isso faria o texto "dançar"): cada um fica no seu tamanho natural,
// centralizado, e a borda da ilha vai revelando/escondendo.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {BOUNCY, SMOOTH, Spring, SpringAnimator} from './spring.js';

// Troca de conteúdo (crossfade). O que sai some rápido; o que entra espera a
// forma abrir espaço e então aparece. ease() já respeita "Reduzir animação".
const FADE_OUT_TIME = 100; // ms
const FADE_IN_TIME = 200; // ms
const FADE_IN_DELAY = 110; // ms

/** Largura mínima da ilha fechada (px lógicos), para parecer um notch. */
const CLOSED_MIN_WIDTH = 160;

export const IslandActor = GObject.registerClass({
    Signals: {
        // A ilha terminou de fechar (forma parada e conteúdo aberto escondido).
        'closed': {},
        // Mudou a largura da ilha fechada (ex.: 9:59 → 10:00).
        'closed-width-changed': {},
    },
}, class LumaMenuIsland extends St.Widget {
    _init() {
        super._init({
            name: 'lumaMenuIsland',
            style_class: 'luma-island',
            reactive: true,
            track_hover: true,
        });

        this._isOpen = false;
        this._monitor = null;
        this._closedHeight = 28;
        this._appearance = {opacity: 0.92, radius: 10};
        this._baseColor = [36, 36, 38];
        this._textColor = null;

        // Probe: um widget com a classe dos menus do tema. Lemos a cor de
        // fundo dele — assim a ilha usa a mesma cor dos menus do Luma Menu
        // (e muda junto se você trocar de tema).
        this._probe = new St.Widget({style_class: 'popup-menu-content', visible: false});
        this.add_child(this._probe);
        this._probe.connect('style-changed', () => this._readThemeColor());

        this._content = new St.Widget({
            style_class: 'luma-island-content',
            clip_to_allocation: true,
        });
        this.add_child(this._content);

        this._closedView = null;
        this._openView = null;

        this._width = new Spring(CLOSED_MIN_WIDTH);
        this._height = new Spring(this._closedHeight);
        // O "progresso" 0 (fechada) → 1 (aberta) controla cantos, cor e
        // sombra. Sem quique: um canto que "passa do ponto" fica estranho.
        this._progress = new Spring(0, SMOOTH);
        this._animator = new SpringAnimator(this,
            [this._width, this._height, this._progress],
            now => this._onFrame(now),
            () => this._onSettled());
        this._retargetLater = 0;
        this._lastClosedWidth = 0;
        this._placed = false;
        this._frameWidth = CLOSED_MIN_WIDTH;
        this._frameHeight = this._closedHeight;

        this.connect('destroy', () => {
            this._animator.destroy();
            if (this._retargetLater)
                global.compositor.get_laters().remove(this._retargetLater);
            this._retargetLater = 0;
        });
        this._applyStyle(0);
    }

    // ----- Configuração -----------------------------------------------------------

    /**
     * @param {Clutter.Actor} closedView
     * @param {Clutter.Actor} openView
     */
    setViews(closedView, openView) {
        this._closedView = closedView;
        this._openView = openView;
        this._content.add_child(closedView);
        this._content.add_child(openView);
        openView.opacity = 0;
        openView.hide();
        // Quando o conteúdo muda de tamanho (hora nova, outra página, mês com
        // 6 semanas), a ilha recalcula o tamanho-alvo.
        for (const view of [closedView, openView])
            view.connect('queue-relayout', () => this._scheduleRetarget());
    }

    /** @param {object} monitor - Main.layoutManager.primaryMonitor */
    setMonitor(monitor) {
        this._monitor = monitor;
        this._place();
    }

    /** @param {number} height - altura do painel (px lógicos) */
    setClosedHeight(height) {
        this._closedHeight = height;
        this._closedView?.set_height(height);
        this.retarget();
    }

    /** @param {{opacity: number, radius: number}} appearance */
    setAppearance(appearance) {
        this._appearance = appearance;
        this._applyStyle(this._progress.value());
    }

    get isOpen() {
        return this._isOpen;
    }

    // ----- Abrir / fechar ---------------------------------------------------------

    open() {
        if (this._isOpen)
            return;
        this._isOpen = true;
        this._crossfade(this._closedView, this._openView);
        this.retarget();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._crossfade(this._openView, this._closedView);
        this.retarget();
    }

    _crossfade(outgoing, incoming) {
        outgoing.reactive = false;
        outgoing.remove_all_transitions();
        outgoing.ease({
            opacity: 0,
            duration: FADE_OUT_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // Escondido = não desenha nem recebe cliques.
                if (outgoing.opacity === 0)
                    outgoing.hide();
            },
        });
        incoming.show();
        incoming.reactive = true;
        incoming.remove_all_transitions();
        incoming.ease({
            opacity: 255,
            delay: FADE_IN_DELAY,
            duration: FADE_IN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ----- Tamanho ----------------------------------------------------------------

    _scheduleRetarget() {
        if (this._retargetLater)
            return;
        // "Laters" rodam uma vez, logo antes do próximo quadro: juntamos
        // várias mudanças de conteúdo num único cálculo.
        const laters = global.compositor.get_laters();
        this._retargetLater = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._retargetLater = 0;
            this.retarget();
            return false;
        });
    }

    /** Recalcula o tamanho-alvo a partir do conteúdo e anima até ele. */
    retarget() {
        if (!this._closedView || !this._openView)
            return;
        const closedWidth = this.closedWidth;
        if (closedWidth !== this._lastClosedWidth) {
            this._lastClosedWidth = closedWidth;
            this.emit('closed-width-changed');
        }
        let w, h;
        if (this._isOpen) {
            [, w] = this._openView.get_preferred_width(-1);
            [, h] = this._openView.get_preferred_height(w);
        } else {
            [, w] = this._closedView.get_preferred_width(this._closedHeight);
            w = Math.max(CLOSED_MIN_WIDTH, w);
            h = this._closedHeight;
        }
        // Largura PAR: assim a ilha fica centralizada no pixel exato.
        w = Math.ceil(w / 2) * 2;
        h = Math.ceil(h);
        if (w === this._width.target && h === this._height.target &&
            this._progress.target === (this._isOpen ? 1 : 0))
            return;
        if (!this._placed) {
            // Primeira vez (extensão acabou de ativar): a ilha já aparece no
            // tamanho certo, sem "crescer" do nada.
            this._placed = true;
            this._width.jumpTo(w);
            this._height.jumpTo(h);
            this._progress.jumpTo(0);
            this._onFrame(0);
            return;
        }
        this._width.setTarget(w, this._isOpen ? BOUNCY : SMOOTH);
        this._height.setTarget(h, this._isOpen ? BOUNCY : SMOOTH);
        this._progress.setTarget(this._isOpen ? 1 : 0);
        this._animator.kick();
    }

    /**
     * Para todas as animações (mola e fades). Chamado antes de tirar a ilha
     * do palco: uma animação rodando num ator fora do palco gera aviso do
     * Clutter ("Timelines with detached actors").
     */
    stopAnimations() {
        this._animator.stop();
        for (const actor of [this._closedView, this._openView])
            actor?.remove_all_transitions();
    }

    /** Largura da ilha FECHADA (usada pelo reservador no painel). */
    get closedWidth() {
        const [, w] = this._closedView?.get_preferred_width(this._closedHeight) ?? [0, 0];
        return Math.ceil(Math.max(CLOSED_MIN_WIDTH, w) / 2) * 2;
    }

    _onFrame(now) {
        // Lemos as molas UMA vez por quadro: posição e tamanho precisam vir
        // do mesmo instante, senão a ilha "escorrega" para o lado enquanto
        // cresce.
        this._frameWidth = Math.max(0, Math.round(this._width.value(now)));
        this._frameHeight = Math.max(0, Math.round(this._height.value(now)));
        this._applyStyle(Math.min(1, Math.max(0, this._progress.value(now))));
        this._place();
        this.queue_relayout();
    }

    _onSettled() {
        if (!this._isOpen)
            this.emit('closed');
    }

    _place() {
        if (!this._monitor)
            return;
        const x = this._monitor.x + Math.round((this._monitor.width - this._frameWidth) / 2);
        this.set_position(x, this._monitor.y);
    }

    vfunc_get_preferred_width(_forHeight) {
        return [this._frameWidth, this._frameWidth];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [this._frameHeight, this._frameHeight];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;

        const contentBox = new Clutter.ActorBox();
        contentBox.set_origin(0, 0);
        contentBox.set_size(width, height);
        this._content.allocate(contentBox);

        // Cada conteúdo no tamanho natural, centralizado na horizontal e
        // preso ao topo (a ilha cresce para baixo).
        for (const view of [this._closedView, this._openView]) {
            if (!view?.visible)
                continue;
            let [, w] = view.get_preferred_width(-1);
            let h;
            if (view === this._closedView) {
                w = Math.max(w, Math.min(width, CLOSED_MIN_WIDTH));
                h = this._closedHeight;
            } else {
                [, h] = view.get_preferred_height(w);
            }
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(Math.round((width - w) / 2), 0);
            childBox.set_size(w, h);
            view.allocate(childBox);
        }
        this._probe.allocate(new Clutter.ActorBox());
    }

    // ----- Aparência --------------------------------------------------------------

    _readThemeColor() {
        const color = this._probe.get_theme_node().get_background_color();
        if (color.alpha > 0)
            this._baseColor = [color.red, color.green, color.blue];
        // A cor do texto também vem dos menus do tema (claro ou escuro).
        const fg = this._probe.get_theme_node().get_foreground_color();
        this._textColor = [fg.red, fg.green, fg.blue];
        this._applyStyle(this._progress.value());
    }

    /**
     * Fechada: SEM fundo — a ilha fechada é só o relógio da barra, com a
     * mesma aparência do painel (pedido do usuário: nada de "pílula" nem de
     * data em outra cor).
     * Aberta: o fundo, a opacidade e o dobro do raio dos menus do Luma Menu,
     * com sombra. Entre os dois, interpolamos pelo progresso da mola: o
     * fundo vai aparecendo enquanto a ilha cresce.
     *
     * @param {number} p - 0 (fechada) a 1 (aberta)
     */
    _applyStyle(p) {
        const {opacity, radius} = this._appearance;
        const [r, g, b] = this._baseColor;
        const alpha = opacity * p;
        // O raio nunca passa da metade da altura (a forma fica limpa mesmo
        // no meio da animação).
        const maxR = Math.floor(this._frameHeight / 2);
        const corner = Math.min(maxR, Math.round(radius + radius * p));
        const shadow = (0.35 * p).toFixed(3);
        const rules = [
            `background-color: rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
            `border-radius: 0 0 ${corner}px ${corner}px`,
            `box-shadow: 0 6px 24px rgba(0, 0, 0, ${shadow})`,
        ];
        this.style = `${rules.join('; ')};`;
        // A cor do texto dos menus vale só para o conteúdo ABERTO; o fechado
        // usa a do painel (aplicada pelo controlador).
        if (this._openView && this._textColor)
            this._openView.style = `color: rgb(${this._textColor.join(', ')});`;
    }
});

