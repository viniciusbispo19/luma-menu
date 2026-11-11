// SPDX-License-Identifier: GPL-3.0-or-later
// Temperatura atual para o relógio, via libgweather (a mesma biblioteca que o
// relógio e o app Clima do GNOME usam). Sem chave de API.
//
// Por que um cliente nosso e não o do Shell (misc/weather.js)? O do Shell não
// tem destroy(): criá-lo numa extensão vazaria sinais a cada desativação.
//
// Localização (nesta ordem):
//   - "manual" nas preferências: a cidade escolhida (latitude/longitude);
//   - "automática": a do GNOME — se a localização automática do Clima estiver
//     ligada, o Geoclue (só a CIDADE, precisão baixa); senão, a primeira
//     cidade salva em org.gnome.shell.weather (Salvador, no seu caso).
// Só coordenadas aproximadas da cidade vão para o serviço de clima.
//
// Atualização: ao ativar, depois a cada 30 min (UM timeout, rearmado) e
// quando a rede volta. Offline ou com erro, fica o último valor, marcado como
// "velho" (o relógio o mostra esmaecido).

import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather?version=4.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {TimeoutRegistry, debug, logError} from '../../util.js';

Gio._promisify(Geoclue.Simple, 'new');

const UPDATE_INTERVAL = 30 * 60 * 1000; // ms
/** Depois disso sem atualizar, o valor guardado é "velho". */
const STALE_AFTER = 2 * 60 * 60; // s
const CONTACT = 'https://github.com/viniciusbispo19/luma-menu';

export class WeatherService extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._timers = new TimeoutRegistry();
        this._updateTimer = 0;
        this._destroyed = false;
        this._failed = false;
        this._value = this._loadCache();

        this._shellWeather = new Gio.Settings({schema_id: 'org.gnome.shell.weather'});
        this._info = new GWeather.Info({
            application_id: 'org.gnome.Shell',
            contact_info: CONTACT,
            enabled_providers: GWeather.Provider.METAR | GWeather.Provider.MET_NO,
        });
        this._info.connectObject('updated', () => this._onUpdated(), this);

        this._network = Gio.NetworkMonitor.get_default();
        this._wasOnline = this._network.network_available;
        this._network.connectObject('network-changed', (_m, available) => {
            // A rede VOLTOU: atualiza na hora (só na volta, não a cada mudança).
            if (available && !this._wasOnline)
                this.refresh();
            this._wasOnline = available;
        }, this);

        settings.connectObject(
            'changed::weather-enabled', () => this._restart(),
            'changed::weather-location-mode', () => this._restart(),
            'changed::weather-manual-coords', () => this._restart(),
            'changed::weather-unit', () => this.emit('changed'),
            this);
        this._shellWeather.connectObject('changed::locations', () => this._restart(), this);

        this._restart();
    }

    /**
     * @returns {object|null} {celsius, icon, condition, stale}; null = sem dado
     *   (ou desligado nas preferências)
     */
    get value() {
        if (!this._settings.get_boolean('weather-enabled') || !this._value)
            return null;
        const age = GLib.get_real_time() / 1e6 - this._value.time;
        return {...this._value, stale: this._failed || age > STALE_AFTER};
    }

    get unit() {
        return this._settings.get_string('weather-unit');
    }

    async _restart() {
        this._timers.remove(this._updateTimer);
        this._updateTimer = 0;
        this._info.abort();
        this.emit('changed');
        if (!this._settings.get_boolean('weather-enabled'))
            return;
        try {
            const location = await this._findLocation();
            if (this._destroyed)
                return;
            if (!location) {
                debug('clima: sem localização');
                return;
            }
            this._info.set_location(location);
            this.refresh();
        } catch (e) {
            logError(e, 'clima: procurando a localização');
        }
    }

    /** Pede dados novos agora (e reprograma o próximo para daqui a 30 min). */
    refresh() {
        if (this._destroyed || !this._info.location)
            return;
        this._timers.remove(this._updateTimer);
        this._updateTimer = this._timers.add(UPDATE_INTERVAL, () => {
            this._updateTimer = 0;
            this.refresh();
        });
        this._info.update();
    }

    async _findLocation() {
        const world = GWeather.Location.get_world();
        if (this._settings.get_string('weather-location-mode') === 'manual') {
            const [lat, lon] = this._settings.get_value('weather-manual-coords').deepUnpack();
            return lat || lon ? world.find_nearest_city(lat, lon) : null;
        }

        // Automática: a mesma escolha do relógio do GNOME.
        const auto = this._shellWeather.get_boolean('automatic-location');
        const locationOn = new Gio.Settings({schema_id: 'org.gnome.system.location'})
            .get_boolean('enabled');
        if (auto && locationOn) {
            try {
                const simple = await Geoclue.Simple.new('org.gnome.Shell',
                    Geoclue.AccuracyLevel.CITY, null);
                const where = simple.get_location();
                if (where)
                    return world.find_nearest_city(where.latitude, where.longitude);
            } catch (e) {
                debug('clima: Geoclue indisponível, usando a cidade salva:', e.message);
            }
        }
        const saved = this._shellWeather.get_value('locations').deepUnpack();
        return saved.length ? world.deserialize(saved[0]) : null;
    }

    _onUpdated() {
        const info = this._info;
        const [ok, celsius] = info.get_value_temp(GWeather.TemperatureUnit.CENTIGRADE);
        if (!info.is_valid() || !ok) {
            // Offline ou erro: fica o último valor, esmaecido. Sem alerta.
            this._failed = true;
            this.emit('changed');
            return;
        }
        this._failed = false;
        // A condição vem traduzida pelo próprio libgweather ("Parcialmente
        // nublado"). "-" = sem fenômeno; aí usamos o céu.
        const conditions = info.get_conditions();
        this._value = {
            celsius,
            icon: info.get_symbolic_icon_name(), // já tem variante dia/noite
            condition: conditions && conditions !== '-' ? conditions : info.get_sky(),
            time: Math.floor(GLib.get_real_time() / 1e6),
        };
        this._saveCache();
        this.emit('changed');
    }

    _loadCache() {
        try {
            const json = this._settings.get_string('weather-cache');
            const value = json ? JSON.parse(json) : null;
            return Number.isFinite(value?.celsius) ? value : null;
        } catch {
            return null;
        }
    }

    _saveCache() {
        this._settings.set_string('weather-cache', JSON.stringify(this._value));
    }

    destroy() {
        this._destroyed = true;
        this._timers.clear();
        this._info.disconnectObject(this);
        this._info.abort();
        this._network.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._shellWeather.disconnectObject(this);
    }
}
