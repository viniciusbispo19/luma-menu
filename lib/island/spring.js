// SPDX-License-Identifier: GPL-3.0-or-later
// Mola amortecida para animar o tamanho da ilha.
//
// Por que mola e não uma animação com duração fixa (ease)? Uma animação com
// duração fixa, se for interrompida no meio (o mouse saiu antes de a ilha
// terminar de abrir), recomeça do zero com velocidade zero: dá um "tranco".
// Uma mola guarda a VELOCIDADE: trocar o alvo no meio do caminho só muda a
// direção, e o movimento continua suave.
//
// A física: a mola puxa o valor x para o alvo com força proporcional à
// distância (rigidez k) e o atrito freia proporcional à velocidade
// (amortecimento c):   x'' = -k·(x - alvo) - c·x'
//
// Em vez de simular quadro a quadro (somando pequenos passos), usamos a
// SOLUÇÃO EXATA dessa equação: dado o instante t, calculamos x(t) direto.
// Vantagens: o resultado não depende da taxa de quadros (60 Hz ou 144 Hz dão
// o mesmo movimento) e não acumula erro numérico.
//
// O "fator de amortecimento" ζ = c / (2·√k) decide o caráter:
//   ζ < 1  → passa um pouquinho do alvo e volta (o "quique" da ilha);
//   ζ ≥ 1  → chega sem passar (usado onde não queremos quique).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** Tamanho da ilha: ζ ≈ 0,78 → ~2% de quique, assenta em ~0,45 s. */
export const BOUNCY = {stiffness: 180, damping: 21};
/** Sem quique (ζ = 1), mesma velocidade. */
export const SMOOTH = {stiffness: 180, damping: 2 * Math.sqrt(180)};

// Consideramos a mola "parada" quando está a menos de 0,3 px do alvo e
// mais lenta que 3 px/s: a partir daí nenhuma mudança é visível.
const REST_DISTANCE = 0.3;
const REST_SPEED = 3;

export class Spring {
    /**
     * @param {number} value - valor inicial (parado)
     * @param {{stiffness: number, damping: number}} [config]
     */
    constructor(value, config = BOUNCY) {
        this._config = config;
        this._target = value;
        // Estado no instante _t0 (µs): deslocamento em relação ao alvo e
        // velocidade (unidades por segundo).
        this._d0 = 0;
        this._v0 = 0;
        this._t0 = GLib.get_monotonic_time();
    }

    get target() {
        return this._target;
    }

    /**
     * Valor e velocidade no instante `now` (µs), pela solução exata.
     *
     * @param {number} now
     * @returns {[number, number]} [valor, velocidade]
     */
    _evaluate(now) {
        const t = Math.max(0, (now - this._t0) / 1e6);
        const k = this._config.stiffness;
        const w0 = Math.sqrt(k);
        const zeta = this._config.damping / (2 * w0);
        const d0 = this._d0, v0 = this._v0;
        let d, v;

        if (zeta < 1) {
            // Subamortecido: oscila dentro de um envelope que decai.
            const alpha = zeta * w0;
            const wd = w0 * Math.sqrt(1 - zeta * zeta);
            const decay = Math.exp(-alpha * t);
            const cos = Math.cos(wd * t), sin = Math.sin(wd * t);
            d = decay * (d0 * cos + ((v0 + alpha * d0) / wd) * sin);
            v = decay * (v0 * cos - ((alpha * v0 + k * d0) / wd) * sin);
        } else {
            // Amortecimento crítico: o mais rápido possível sem passar do alvo.
            const decay = Math.exp(-w0 * t);
            const b = v0 + w0 * d0;
            d = (d0 + b * t) * decay;
            v = (v0 - w0 * b * t) * decay;
        }
        return [this._target + d, v];
    }

    /**
     * @param {number} [now] - µs (GLib.get_monotonic_time)
     * @returns {number}
     */
    value(now = GLib.get_monotonic_time()) {
        return this.isSettled(now) ? this._target : this._evaluate(now)[0];
    }

    /**
     * @param {number} [now]
     * @returns {boolean}
     */
    isSettled(now = GLib.get_monotonic_time()) {
        if (this._d0 === 0 && this._v0 === 0)
            return true;
        const [x, v] = this._evaluate(now);
        return Math.abs(x - this._target) < REST_DISTANCE && Math.abs(v) < REST_SPEED;
    }

    /**
     * Muda o alvo SEM perder a velocidade atual.
     *
     * @param {number} target
     * @param {object} [config] - opcional: troca rigidez/amortecimento
     */
    setTarget(target, config = this._config) {
        const now = GLib.get_monotonic_time();
        const [x, v] = this.isSettled(now) ? [this._target, 0] : this._evaluate(now);
        this._config = config;
        this._target = target;
        this._d0 = x - target;
        this._v0 = v;
        this._t0 = now;
    }

    /** Pula direto para `value`, parado (ex.: "Reduzir animação"). */
    jumpTo(value) {
        this._target = value;
        this._d0 = 0;
        this._v0 = 0;
        this._t0 = GLib.get_monotonic_time();
    }
}

/**
 * Faz um conjunto de molas avançar a cada quadro da tela — e SÓ enquanto
 * alguma delas está em movimento. Parada, a ilha não pede nenhum quadro.
 *
 * Usamos um Clutter.Timeline ligado ao ator: ele segue o "relógio de quadros"
 * do monitor onde o ator está (sincronizado com a tela, sem timers).
 */
export class SpringAnimator {
    /**
     * @param {Clutter.Actor} actor - ator cujo relógio de quadros usamos
     * @param {Spring[]} springs
     * @param {Function} onFrame - (now) => void; aplica os valores
     * @param {Function} [onSettled] - chamado quando todas param
     */
    constructor(actor, springs, onFrame, onSettled = null) {
        this._springs = springs;
        this._onFrame = onFrame;
        this._onSettled = onSettled;
        // Duração longa + repetição infinita: paramos nós mesmos quando as
        // molas assentam.
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
    }

    /** Chame depois de mudar o alvo de alguma mola. */
    kick() {
        if (!this._timeline)
            return;
        // "Reduzir animação" (Acessibilidade): sem movimento, vai direto ao fim.
        if (!St.Settings.get().enable_animations) {
            for (const spring of this._springs)
                spring.jumpTo(spring.target);
            this._timeline.stop();
            this._onFrame(GLib.get_monotonic_time());
            this._onSettled?.();
            return;
        }
        if (!this._timeline.is_playing())
            this._timeline.start();
        this._tick();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        this._onFrame(now);
        if (this._springs.every(s => s.isSettled(now))) {
            this._timeline.stop();
            this._onSettled?.();
        }
    }

    /** Para no estado atual (sem chamar onSettled). */
    stop() {
        this._timeline?.stop();
    }

    get isRunning() {
        return this._timeline?.is_playing() ?? false;
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
    }
}
