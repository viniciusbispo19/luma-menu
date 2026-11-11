// SPDX-License-Identifier: GPL-3.0-or-later
// Lembretes: uma lista simples (adicionar, renomear, marcar como feito),
// salva em ~/.local/share/luma-menu/reminders.json.
//
// Vive na extensão (não no relógio): a interface da barra é destruída ao
// bloquear a tela, mas a lista continua a mesma.

import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {dataFile, loadJson, saveJson} from './storage.js';
import {logError} from '../../util.js';

/** Depois de marcado, o lembrete fica riscado por um instante e some. */
const DONE_LINGER = 1500; // ms
/** Várias mudanças seguidas viram uma gravação só. */
const SAVE_DELAY = 500; // ms

export class ReminderStore extends Signals.EventEmitter {
    constructor() {
        super();
        this._file = dataFile('reminders.json');
        this._items = []; // {id, text, done, created}
        this._loaded = false;
        this._saveId = 0;
        this._lingerIds = new Map(); // id → timer
        loadJson(this._file, {items: []}).then(data => {
            if (this._destroyed)
                return;
            this._items = (data?.items ?? []).filter(i => i && typeof i.text === 'string' && !i.done);
            this._loaded = true;
            this.emit('changed');
        });
    }

    /** @returns {object[]} lembretes, mais antigos primeiro */
    get items() {
        return this._items;
    }

    add(text) {
        text = text.trim();
        if (!text)
            return;
        this._items.push({
            id: GLib.uuid_string_random(),
            text,
            done: false,
            created: Math.floor(Date.now() / 1000),
        });
        this._changed();
    }

    /** Renomear para vazio apaga. */
    rename(id, text) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        text = text.trim();
        if (!text)
            this._items = this._items.filter(i => i !== item);
        else
            item.text = text;
        this._changed();
    }

    /** Marca como feito: fica riscado por um instante e some. */
    complete(id) {
        const item = this._items.find(i => i.id === id);
        if (!item || item.done)
            return;
        item.done = true;
        this.emit('changed');
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DONE_LINGER, () => {
            this._lingerIds.delete(id);
            this._items = this._items.filter(i => i.id !== id);
            this._changed();
            return GLib.SOURCE_REMOVE;
        });
        this._lingerIds.set(id, timer);
    }

    _changed() {
        this.emit('changed');
        if (!this._loaded)
            return; // não sobrescreve o arquivo antes de lê-lo
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        const items = this._items.filter(i => !i.done);
        saveJson(this._file, {version: 1, items}).catch(e => logError(e, 'salvando lembretes'));
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._lingerIds.values())
            GLib.source_remove(id);
        this._lingerIds.clear();
        // Gravação pendente: grava agora (sem perder o que acabou de mudar).
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
    }
}
