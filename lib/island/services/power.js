// SPDX-License-Identifier: GPL-3.0-or-later
// Estado da bateria (UPower) e do modo de economia (power-profiles-daemon ou
// tuned-ppd), só por SINAIS do D-Bus — nada de perguntar a cada X segundos.
//
// UPower expõe um "DisplayDevice": a bateria combinada do notebook, a mesma
// que o ícone do GNOME usa. Quando algo muda (porcentagem, carregando, tempo
// restante), ele emite PropertiesChanged; o proxy do Gio guarda os valores
// e emite "g-properties-changed".

import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {isExpectedDBusError, logError} from '../../util.js';

// As mesmas interfaces que o GNOME Shell usa (ui/status/system.js e
// ui/status/powerProfiles.js), vindas dos recursos do próprio Shell.
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));
const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.PowerProfiles'));

// Estados do UPower (org.freedesktop.UPower.Device, propriedade State).
const State = {
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
};

export class PowerService extends Signals.EventEmitter {
    constructor() {
        super();
        this._device = null;
        this._profiles = null;
        this._cancellable = new Gio.Cancellable();

        // O construtor do proxy com callback é ASSÍNCRONO (não trava o Shell).
        new UPowerDeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (error) {
                    if (!isExpectedDBusError(error))
                        logError(error, 'conectando ao UPower');
                    return;
                }
                this._device = proxy;
                proxy.connectObject('g-properties-changed', () => this.emit('changed'), this);
                this.emit('changed');
            }, this._cancellable);

        new PowerProfilesProxy(Gio.DBus.system, 'org.freedesktop.UPower.PowerProfiles',
            '/org/freedesktop/UPower/PowerProfiles',
            (proxy, error) => {
                if (error) {
                    // Sem power-profiles-daemon/tuned-ppd: só não há "economia".
                    return;
                }
                this._profiles = proxy;
                proxy.connectObject('g-properties-changed', () => this.emit('changed'), this);
                this.emit('changed');
            }, this._cancellable);
    }

    /**
     * @returns {object|null} null se não há bateria (desktop) ou ainda não leu
     */
    get state() {
        const d = this._device;
        if (!d || !d.IsPresent)
            return null;
        const state = d.State;
        const charging = state === State.CHARGING;
        const full = state === State.FULLY_CHARGED;
        return {
            percentage: d.Percentage,
            charging,
            full,
            // Na tomada mas sem carregar: cheia, ou segurando a carga.
            pluggedIn: charging || full || state === State.PENDING_CHARGE,
            timeToEmpty: Number(d.TimeToEmpty ?? 0),
            timeToFull: Number(d.TimeToFull ?? 0),
            powerSaver: this._profiles?.ActiveProfile === 'power-saver',
        };
    }

    destroy() {
        this._cancellable.cancel();
        this._device?.disconnectObject(this);
        this._profiles?.disconnectObject(this);
        this._device = null;
        this._profiles = null;
    }
}
