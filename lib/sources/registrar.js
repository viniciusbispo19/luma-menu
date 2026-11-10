// SPDX-License-Identifier: GPL-3.0-or-later
// Serviço com.canonical.AppMenu.Registrar (camada B).
//
// Apps Qt, Electron/Chromium e outros que usam DBusMenu procuram este serviço
// no barramento de sessão quando abrem. Se ele existe, o app "registra" cada
// janela: RegisterWindow(id da janela X11, caminho do menu). Nós guardamos
// essa tabela (janela → serviço D-Bus + caminho) e, quando a janela ganha
// foco, lemos o menu dela pelo protocolo com.canonical.dbusmenu.
//
// Limitação real: o "id da janela" é um XID do X11. Por isso a camada B
// funciona com apps rodando via XWayland. Em Wayland nativo, Qt e Chromium
// não registram janelas neste serviço.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {debug, logError} from '../util.js';

const BUS_NAME = 'com.canonical.AppMenu.Registrar';
const OBJECT_PATH = '/com/canonical/AppMenu/Registrar';

const REGISTRAR_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="menuObjectPath"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

/**
 * XID (id X11) de uma janela XWayland. O Mutter 51 não expõe
 * get_xwindow() ao JavaScript, mas a "descrição" da janela X11 começa com o
 * XID em hexadecimal: "0x4a00003 (Título)". Janelas Wayland começam com "W".
 *
 * @param {Meta.Window} window
 * @returns {number|null}
 */
export function getXid(window) {
    const match = window?.get_description()?.match(/^0x([0-9a-f]+)/i);
    return match ? parseInt(match[1], 16) : null;
}

export class Registrar extends Signals.EventEmitter {
    constructor() {
        super();
        this._windows = new Map(); // xid → {service, path}
        this._watches = new Map(); // serviço → id do watch (para limpar quando o app fecha)

        this._impl = Gio.DBusExportedObject.wrapJSObject(REGISTRAR_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);

        // Pedimos o nome sem "tomar" de outro dono (ex.: um registrar de
        // outro painel). Se não conseguirmos, a camada B fica inativa.
        this._ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => debug('Registrar: nome adquirido'),
            () => debug('Registrar: outro processo já é o dono do nome'));
    }

    // ----- Métodos D-Bus (chamados pelos apps) -------------------------------
    // O sufixo "Async" faz o GJS nos entregar a "invocation", de onde tiramos
    // o nome D-Bus de quem chamou (o "serviço" do menu).

    RegisterWindowAsync([windowId, menuPath], invocation) {
        const service = invocation.get_sender();
        this._windows.set(windowId, {service, path: menuPath});
        this._watchService(service);
        debug(`Registrar: janela 0x${windowId.toString(16)} → ${service} ${menuPath}`);
        this._impl.emit_signal('WindowRegistered',
            new GLib.Variant('(uso)', [windowId, service, menuPath]));
        this.emit('changed', windowId);
        invocation.return_value(null);
    }

    UnregisterWindow(windowId) {
        if (this._windows.delete(windowId)) {
            this._impl.emit_signal('WindowUnregistered', new GLib.Variant('(u)', [windowId]));
            this.emit('changed', windowId);
        }
    }

    GetMenuForWindow(windowId) {
        const entry = this._windows.get(windowId);
        return entry ? [entry.service, entry.path] : ['', '/'];
    }

    GetMenus() {
        return [[...this._windows].map(([id, e]) => [id, e.service, e.path])];
    }

    // ----- Uso interno -------------------------------------------------------

    /** Quando o app sai do barramento (fechou/travou), esquecemos as janelas dele. */
    _watchService(service) {
        if (this._watches.has(service))
            return;
        const id = Gio.bus_watch_name_on_connection(Gio.DBus.session, service,
            Gio.BusNameWatcherFlags.NONE, null, () => {
                for (const [xid, entry] of this._windows) {
                    if (entry.service === service) {
                        this._windows.delete(xid);
                        this.emit('changed', xid);
                    }
                }
                Gio.bus_unwatch_name(id);
                this._watches.delete(service);
            });
        this._watches.set(service, id);
    }

    /**
     * Menu registrado para uma janela (ou para a janela "dona" dela, no caso
     * de diálogos).
     *
     * @param {Meta.Window} window
     * @returns {{service: string, path: string}|null}
     */
    lookup(window) {
        for (let w = window; w; w = w.get_transient_for()) {
            const xid = getXid(w);
            if (xid !== null && this._windows.has(xid))
                return this._windows.get(xid);
        }
        return null;
    }

    destroy() {
        try {
            Gio.bus_unown_name(this._ownerId);
            this._impl.unexport();
        } catch (e) {
            logError(e, 'encerrando o Registrar');
        }
        for (const id of this._watches.values())
            Gio.bus_unwatch_name(id);
        this._watches.clear();
        this._windows.clear();
    }
}
