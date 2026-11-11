// SPDX-License-Identifier: GPL-3.0-or-later
// Alertas do sistema que saem do relógio — poucos e só quando importam:
//
//   - bateria fraca: UMA vez ao cruzar 20% e outra ao cruzar 10% (sem estar
//     carregando). Cada limite avisa uma vez por descarga, e só volta a valer
//     depois que a bateria subir acima dele. 10% é urgente: fura o Não
//     Perturbe;
//   - bateria carregada (desligado por padrão);
//   - Caps Lock: ao ligar/desligar;
//   - Bluetooth: um dispositivo conectou/desconectou;
//   - rede: só depois de alguns segundos offline (sem piscar), e "voltou"
//     apenas se tínhamos avisado que caiu.
//
// Nada de verificar de tempos em tempos: tudo vem de sinais (UPower, teclado,
// BlueZ via GnomeBluetooth, Gio.NetworkMonitor). Cada alerta tem sua chave
// nas preferências.

import Gio from 'gi://Gio';
import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';

import {PowerService} from './power.js';
import {T, formatLowBattery} from '../strings.js';
import {TimeoutRegistry} from '../../util.js';

const LOW_LEVELS = [20, 10]; // %
const URGENT_LEVEL = 10;
/** Offline por mais que isso antes de avisar (evita piscar). */
const OFFLINE_DELAY = 5000; // ms

export class SystemAlerts {
    /**
     * @param {Gio.Settings} settings
     * @param {AlertPresenter} alerts
     */
    constructor(settings, alerts) {
        this._settings = settings;
        this._alerts = alerts;
        this._timers = new TimeoutRegistry();

        // ----- Bateria -----
        this._power = new PowerService();
        this._warned = new Set(); // limites já avisados nesta descarga
        this._wasFull = null;
        this._power.connectObject('changed', () => this._checkBattery(), this);

        // ----- Caps Lock -----
        const seat = global.stage.context.get_backend().get_default_seat();
        this._keymap = seat.get_keymap();
        this._capsLock = this._keymap.get_caps_lock_state();
        this._keymap.connectObject('state-changed', () => this._checkCapsLock(), this);

        // ----- Bluetooth -----
        this._bluetooth = new GnomeBluetooth.Client();
        this._btConnected = new Map(); // caminho do dispositivo → conectado?
        const store = this._bluetooth.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            this._watchDevice(store.get_item(i));
        this._bluetooth.connectObject(
            'device-added', (_c, device) => this._watchDevice(device),
            'device-removed', (_c, path) => this._btConnected.delete(path),
            this);

        // ----- Rede -----
        this._network = Gio.NetworkMonitor.get_default();
        this._online = this._network.network_available;
        this._offlineTimer = 0;
        this._offlineAlerted = false;
        this._network.connectObject('network-changed', (_m, available) => this._checkNetwork(available), this);
    }

    // ----- Bateria ------------------------------------------------------------------

    _checkBattery() {
        const s = this._power.state;
        if (!s)
            return;

        // Na tomada (ou subiu acima de um limite): o limite volta a valer.
        for (const level of [...this._warned]) {
            if (s.pluggedIn || s.percentage > level + 2)
                this._warned.delete(level);
        }

        if (!s.pluggedIn && this._settings.get_boolean('alert-battery-low')) {
            // Se cruzou os dois de uma vez, avisa só o mais baixo.
            const crossed = LOW_LEVELS.filter(l => s.percentage <= l && !this._warned.has(l));
            if (crossed.length > 0) {
                crossed.forEach(l => this._warned.add(l));
                const level = Math.min(...crossed);
                this._alerts.showMessage({
                    key: `battery-low-${level}`,
                    iconName: level <= URGENT_LEVEL ? 'battery-level-10-symbolic' : 'battery-level-20-symbolic',
                    title: T.lowBattery,
                    subtitle: formatLowBattery(s.percentage),
                    duration: 8000,
                    urgent: level <= URGENT_LEVEL,
                });
            }
        }

        // Carregou até o fim (só na transição, e só se a opção estiver ligada).
        if (this._wasFull === false && s.full && this._settings.get_boolean('alert-battery-full')) {
            this._alerts.showMessage({
                key: 'battery-full',
                iconName: 'battery-level-100-charged-symbolic',
                title: T.batteryCharged,
            });
        }
        this._wasFull = s.full;
    }

    // ----- Caps Lock ----------------------------------------------------------------

    _checkCapsLock() {
        const on = this._keymap.get_caps_lock_state();
        if (on === this._capsLock)
            return; // outra tecla de estado mudou (Num Lock…)
        this._capsLock = on;
        if (!this._settings.get_boolean('alert-caps-lock'))
            return;
        // O aviso anterior sai na hora (ligar e desligar rápido não enfileira).
        this._alerts.withdraw('caps-lock');
        this._alerts.showMessage({
            key: 'caps-lock',
            iconName: 'input-keyboard-symbolic',
            title: on ? T.capsLockOn : T.capsLockOff,
            duration: 1500,
            dedupe: false,
        });
    }

    // ----- Bluetooth ----------------------------------------------------------------

    _watchDevice(device) {
        this._btConnected.set(device.get_object_path(), device.connected);
        device.connectObject('notify::connected', () => {
            const path = device.get_object_path();
            if (this._btConnected.get(path) === device.connected)
                return;
            this._btConnected.set(path, device.connected);
            if (!this._settings.get_boolean('alert-bluetooth'))
                return;
            this._alerts.showMessage({
                key: `bluetooth-${path}-${device.connected}`,
                iconName: device.icon ? `${device.icon}-symbolic` : 'bluetooth-active-symbolic',
                title: device.alias || device.name || 'Bluetooth',
                subtitle: device.connected ? T.connected : T.disconnected,
            });
        }, this);
    }

    // ----- Rede -------------------------------------------------------------------------

    _checkNetwork(available) {
        if (available === this._online)
            return;
        this._online = available;
        this._timers.remove(this._offlineTimer);
        this._offlineTimer = 0;

        if (!available) {
            // Só avisa se continuar offline por alguns segundos.
            this._offlineTimer = this._timers.add(OFFLINE_DELAY, () => {
                this._offlineTimer = 0;
                if (this._online || !this._settings.get_boolean('alert-network'))
                    return;
                this._offlineAlerted = true;
                this._alerts.showMessage({
                    key: 'network-offline',
                    iconName: 'network-offline-symbolic',
                    title: T.offline,
                    subtitle: T.offlineHint,
                });
            });
        } else if (this._offlineAlerted) {
            // Voltou — e só dizemos isso porque tínhamos avisado que caiu.
            this._offlineAlerted = false;
            this._alerts.withdraw('network-offline');
            this._alerts.showMessage({
                key: 'network-online',
                iconName: 'network-wireless-symbolic',
                title: T.backOnline,
            });
        }
    }

    destroy() {
        this._timers.clear();
        this._power.disconnectObject(this);
        this._power.destroy();
        this._keymap.disconnectObject(this);
        this._bluetooth.disconnectObject(this);
        const store = this._bluetooth.get_devices();
        for (let i = 0; i < store.get_n_items(); i++)
            store.get_item(i).disconnectObject(this);
        this._bluetooth = null;
        this._network.disconnectObject(this);
    }
}
