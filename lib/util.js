// SPDX-License-Identifier: GPL-3.0-or-later
// Utilitários compartilhados: log de depuração, timers rastreados e leitura
// assíncrona de arquivos.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// O GJS não transforma automaticamente todos os métodos *_async do Gio em
// Promises. _promisify ensina o GJS a fazê-lo para os métodos que usamos,
// permitindo escrever `await file.load_contents_async(null)`.
// (O próprio GNOME Shell faz o mesmo em ui/environment.js.)
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusProxy, 'new');

let _debugEnabled = false;

/**
 * Liga/desliga as mensagens de depuração (opção "Modo de depuração").
 *
 * @param {boolean} enabled
 */
export function setDebug(enabled) {
    _debugEnabled = enabled;
}

/**
 * Escreve no journal só quando o modo de depuração está ligado.
 * Veja com: journalctl -f -o cat /usr/bin/gnome-shell | grep Luma
 *
 * @param {...any} args
 */
export function debug(...args) {
    if (_debugEnabled)
        console.log('[Luma Menu]', ...args);
}

/**
 * Registra um erro inesperado no journal (sempre, mesmo sem depuração).
 *
 * @param {Error} error
 * @param {string} context - onde aconteceu
 */
export function logError(error, context) {
    console.warn(`[Luma Menu] ${context}: ${error?.message ?? error}`);
}

/**
 * Erros "esperados" de D-Bus: o app fechou, o objeto sumiu, o serviço não
 * existe. Não são bugs nossos — não poluímos o journal com eles.
 *
 * @param {Error} error
 * @returns {boolean}
 */
export function isExpectedDBusError(error) {
    if (!(error instanceof GLib.Error))
        return false;
    return error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
        error.matches(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) ||
        error.matches(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER) ||
        error.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) ||
        error.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_OBJECT) ||
        error.matches(Gio.DBusError, Gio.DBusError.NO_REPLY) ||
        error.matches(Gio.DBusError, Gio.DBusError.DISCONNECTED);
}

/**
 * Guarda os timers (GLib.timeout_add/idle_add) criados por um componente,
 * para cancelar todos de uma vez no destroy(). Um timer esquecido depois do
 * disable() é um dos motivos mais comuns de rejeição no extensions.gnome.org.
 */
export class TimeoutRegistry {
    constructor() {
        this._ids = new Set();
    }

    /**
     * @param {number} ms - atraso em milissegundos (0 = assim que der)
     * @param {Function} callback - executado uma única vez
     * @returns {number} id do timer
     */
    add(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._ids.delete(id);
            try {
                callback();
            } catch (e) {
                logError(e, 'timer');
            }
            return GLib.SOURCE_REMOVE;
        });
        this._ids.add(id);
        return id;
    }

    /** @param {number} id */
    remove(id) {
        if (this._ids.delete(id))
            GLib.source_remove(id);
    }

    clear() {
        for (const id of this._ids)
            GLib.source_remove(id);
        this._ids.clear();
    }
}

/**
 * Lê um arquivo de texto sem travar o Shell (assíncrono).
 *
 * @param {string} path
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string|null>} conteúdo, ou null se não existir/não puder ler
 */
export async function readTextFile(path, cancellable = null) {
    try {
        const file = Gio.File.new_for_path(path);
        const [bytes] = await file.load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
            !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            logError(e, `lendo ${path}`);
        return null;
    }
}

/**
 * Lê um arquivo no formato CHAVE=valor (como /etc/os-release).
 *
 * @param {string} text
 * @returns {Object<string, string>}
 */
export function parseKeyValueFile(text) {
    const result = {};
    for (const line of (text ?? '').split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
        if (!match)
            continue;
        let value = match[2].trim();
        // Remove aspas simples ou duplas em volta do valor.
        if (/^(["']).*\1$/.test(value))
            value = value.slice(1, -1);
        result[match[1]] = value.replace(/\\(["'\\$`])/g, '$1');
    }
    return result;
}

/**
 * Lê uma propriedade D-Bus de forma assíncrona.
 *
 * @param {Gio.BusType} busType - Gio.BusType.SYSTEM ou SESSION
 * @param {string} name - nome do serviço
 * @param {string} path - caminho do objeto
 * @param {string} iface - interface
 * @param {string} property - propriedade
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<any>} valor já convertido para JS (ou null)
 */
export async function getDBusProperty(busType, name, path, iface, property, cancellable = null) {
    try {
        // Gio.DBus.system/session reaproveitam a conexão que o Shell já abriu.
        const bus = busType === Gio.BusType.SYSTEM ? Gio.DBus.system : Gio.DBus.session;
        const reply = await bus.call(name, path,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [iface, property]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, cancellable);
        return reply.recursiveUnpack()[0];
    } catch (e) {
        if (!isExpectedDBusError(e))
            logError(e, `lendo ${iface}.${property}`);
        return null;
    }
}
