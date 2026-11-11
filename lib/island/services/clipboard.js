// SPDX-License-Identifier: GPL-3.0-or-later
// Histórico da área de transferência (a "prateleira" do Isle): textos, links,
// imagens e arquivos copiados, mais recentes primeiro.
//
// Como sabemos que algo foi copiado? O Mutter avisa quando o "dono" da
// área de transferência muda (Meta.Selection, sinal "owner-changed") — nada
// de verificar de tempos em tempos. Aí lemos o conteúdo pelo St.Clipboard, de
// forma assíncrona (o app que copiou é quem entrega os dados).
//
// Privacidade:
//   - gerenciadores de senha (KeePassXC e outros) marcam o que copiam com o
//     tipo "x-kde-passwordManagerHint": isso NUNCA entra no histórico;
//   - nada é lido com a tela bloqueada (o GNOME até esvazia a área de
//     transferência ao bloquear);
//   - dá para pausar o histórico (nada novo é guardado enquanto pausado);
//   - com "guardar entre sessões" desligado, nada vai para o disco: as
//     imagens ficam em $XDG_RUNTIME_DIR (memória, apagado ao sair da sessão).
//
// Vive na EXTENSÃO (não no relógio): a interface é destruída ao bloquear a
// tela, mas o histórico continua.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {dataFile, ensureDirectory, loadJson, saveJson} from './storage.js';
import {TimeoutRegistry, debug, logError} from '../../util.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
/** Marcas que os gerenciadores de senha põem no que copiam. */
const SECRET_MIMES = ['x-kde-passwordManagerHint'];
/** Arquivos copiados no Arquivos (Nautilus) ou em outros apps. */
const FILE_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
const IMAGE_MIMES = ['image/png', 'image/jpeg'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];
/** Imagens maiores que isso não entram (um print 4K em PNG tem ~5 MB). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Textos maiores que isso não entram (um arquivo inteiro colado…). */
const MAX_TEXT_LENGTH = 200 * 1000;
const SAVE_DELAY = 1000; // ms
const LINK = /^(?:https?|ftp):\/\/\S+$/i;

export class ClipboardHistory extends Signals.EventEmitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._items = []; // {id, kind, text?, uris?, image?, mime?, hash?, time, pinned}
        this._serial = 0;
        this._timers = new TimeoutRegistry();
        this._saveTimer = 0;
        this._file = dataFile('clipboard.json');
        this._clipboard = St.Clipboard.get_default();

        global.display.get_selection().connectObject('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onOwnerChanged().catch(e => logError(e, 'lendo a área de transferência'));
        }, this);
        settings.connectObject(
            'changed::clipboard-history-size', () => this._trim() && this._changed(),
            'changed::clipboard-save-history', () => this._onSaveSettingChanged(),
            'changed::clipboard-paused', () => this.emit('changed'),
            this);

        if (this._persistent) {
            loadJson(this._file, {items: []}).then(data => this._load(data))
                .catch(e => logError(e, 'carregando o histórico'));
        }
    }

    /** @returns {object[]} fixados primeiro, depois do mais novo ao mais velho */
    get items() {
        return [...this._items.filter(i => i.pinned), ...this._items.filter(i => !i.pinned)];
    }

    get paused() {
        return this._settings.get_boolean('clipboard-paused');
    }

    set paused(value) {
        this._settings.set_boolean('clipboard-paused', value);
    }

    get _persistent() {
        return this._settings.get_boolean('clipboard-save-history');
    }

    /** Pasta das imagens: no disco (guardando) ou na memória ($XDG_RUNTIME_DIR). */
    get _imageDir() {
        return this._persistent
            ? dataFile('clipboard')
            : Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'luma-menu', 'clipboard']));
    }

    async _load(data) {
        if (this._destroyed)
            return;
        const valid = (data?.items ?? []).filter(i => i && typeof i.id === 'string' &&
            ['text', 'link', 'image', 'files'].includes(i.kind));
        // Imagens cujo arquivo sumiu ficam de fora.
        const items = [];
        for (const item of valid) {
            if (item.kind === 'image' && !Gio.File.new_for_path(item.image).query_exists(null))
                continue;
            items.push(item);
        }
        // O que foi copiado enquanto carregava fica na frente.
        this._items = [...this._items, ...items.filter(i => !this._items.some(n => sameContent(n, i)))];
        this._trim();
        this.emit('changed');
    }

    // ----- Leitura -------------------------------------------------------------------

    async _onOwnerChanged() {
        if (this.paused || Main.sessionMode.isLocked)
            return;
        // Cópias rápidas em sequência: só a última leitura vale.
        const serial = ++this._serial;
        const mimes = this._clipboard.get_mimetypes(CLIPBOARD);
        if (!mimes.length || mimes.some(m => SECRET_MIMES.includes(m))) {
            if (mimes.length)
                debug('clipboard: conteúdo marcado como senha, ignorado');
            return;
        }

        let item = null;
        const fileMime = FILE_MIMES.find(m => mimes.includes(m));
        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m));
        const hasText = mimes.some(m => TEXT_MIMES.includes(m));
        if (fileMime) {
            const uris = parseUris(await this._getContent(fileMime));
            if (uris.length)
                item = {kind: 'files', uris};
        } else if (hasText) {
            // Texto vem antes de imagem: planilhas e editores oferecem as duas
            // coisas ao copiar texto, e quem copia texto quer o texto.
            const text = await this._getText();
            if (text && text.trim() && text.length <= MAX_TEXT_LENGTH)
                item = {kind: LINK.test(text.trim()) ? 'link' : 'text', text};
        } else if (imageMime) {
            const bytes = await this._getContent(imageMime);
            if (bytes && bytes.get_size() > 0 && bytes.get_size() <= MAX_IMAGE_BYTES) {
                const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
                item = {kind: 'image', mime: imageMime, hash, bytes};
            }
        }
        if (!item || serial !== this._serial || this._destroyed)
            return;
        await this._add(item);
    }

    _getText() {
        return new Promise(resolve => this._clipboard.get_text(CLIPBOARD, (_c, text) => resolve(text)));
    }

    /**
     * Atenção: o GLib.Bytes que o St entrega só vale DURANTE o callback (ele
     * é liberado logo depois). Por isso copiamos os dados ali mesmo — usar o
     * objeto depois de um await dá CRITICAL e lixo na memória.
     */
    _getContent(mime) {
        return new Promise(resolve =>
            this._clipboard.get_content(CLIPBOARD, mime, (_c, bytes) =>
                resolve(bytes && bytes.get_size() > 0 ? GLib.Bytes.new(bytes.toArray()) : null)));
    }

    async _add(item) {
        // Já existe? Só sobe para o topo (copiar do histórico também cai aqui).
        const existing = this._items.find(i => sameContent(i, item));
        if (existing) {
            existing.time = now();
            this._items = [existing, ...this._items.filter(i => i !== existing)];
            this._changed();
            return;
        }
        const entry = {
            id: GLib.uuid_string_random(),
            kind: item.kind,
            time: now(),
            pinned: false,
        };
        if (item.kind === 'files') {
            entry.uris = item.uris;
        } else if (item.kind === 'image') {
            const dir = this._imageDir;
            await ensureDirectory(dir);
            const file = dir.get_child(`${item.hash}.${item.mime === 'image/jpeg' ? 'jpg' : 'png'}`);
            await file.replace_contents_bytes_async(item.bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
            if (this._destroyed)
                return;
            Object.assign(entry, {image: file.get_path(), mime: item.mime, hash: item.hash});
        } else {
            entry.text = item.text;
        }
        debug('clipboard: novo item', entry.kind);
        this._items.unshift(entry);
        this._trim();
        this._changed();
    }

    /**
     * Mantém só os N mais recentes NÃO fixados (os fixados ficam sempre).
     *
     * @returns {boolean} se algo saiu
     */
    _trim() {
        const max = this._settings.get_int('clipboard-history-size');
        const unpinned = this._items.filter(i => !i.pinned);
        if (unpinned.length <= max)
            return false;
        const drop = new Set(unpinned.slice(max));
        drop.forEach(i => this._deleteImage(i));
        this._items = this._items.filter(i => !drop.has(i));
        return true;
    }

    // ----- Ações ---------------------------------------------------------------------

    /**
     * Põe o item de volta na área de transferência.
     *
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async copy(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return false;
        if (item.kind === 'text' || item.kind === 'link') {
            this._clipboard.set_text(CLIPBOARD, item.text);
        } else if (item.kind === 'image') {
            const [bytes] = await Gio.File.new_for_path(item.image).load_bytes_async(null);
            this._clipboard.set_content(CLIPBOARD, item.mime, bytes);
        } else {
            // O formato padrão de lista de arquivos (o mesmo do GTK 4): colar
            // no Arquivos, no navegador ou num e-mail funciona.
            const text = `${item.uris.join('\r\n')}\r\n`;
            this._clipboard.set_content(CLIPBOARD, 'text/uri-list', new TextEncoder().encode(text));
        }
        return true;
    }

    togglePin(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        item.pinned = !item.pinned;
        this._trim();
        this._changed();
    }

    remove(id) {
        const item = this._items.find(i => i.id === id);
        if (!item)
            return;
        this._deleteImage(item);
        this._items = this._items.filter(i => i !== item);
        this._changed();
    }

    /** Limpa tudo o que não está fixado. */
    clear() {
        const keep = this._items.filter(i => i.pinned);
        this._items.filter(i => !i.pinned).forEach(i => this._deleteImage(i));
        this._items = keep;
        this._changed();
    }

    _deleteImage(item) {
        if (item.kind !== 'image' || this._items.some(i => i !== item && i.image === item.image))
            return;
        Gio.File.new_for_path(item.image).delete_async(GLib.PRIORITY_DEFAULT, null)
            .catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    logError(e, 'apagando imagem do histórico');
            });
    }

    // ----- Gravação ------------------------------------------------------------------

    _changed() {
        this.emit('changed');
        if (!this._persistent || this._saveTimer)
            return;
        this._saveTimer = this._timers.add(SAVE_DELAY, () => {
            this._saveTimer = 0;
            this._save();
        });
    }

    _save() {
        if (!this._persistent)
            return;
        saveJson(this._file, {version: 1, items: this._items})
            .catch(e => logError(e, 'gravando o histórico da área de transferência'));
    }

    /** "Guardar entre sessões" desligado: apaga do disco o que já estava lá. */
    _onSaveSettingChanged() {
        if (this._persistent) {
            this._save();
            return;
        }
        this._file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        const diskDir = dataFile('clipboard').get_path();
        const onDisk = this._items.filter(i => i.kind === 'image' && i.image.startsWith(diskDir));
        onDisk.forEach(i => this._deleteImage(i));
        this._items = this._items.filter(i => !onDisk.includes(i));
        this.emit('changed');
    }

    destroy() {
        this._destroyed = true;
        // Uma última gravação se havia uma pendente.
        if (this._saveTimer)
            this._save();
        this._timers.clear();
        global.display.get_selection().disconnectObject(this);
        this._settings.disconnectObject(this);
    }
}

function now() {
    return Math.floor(Date.now() / 1000);
}

function sameContent(a, b) {
    if (a.kind !== b.kind)
        return false;
    if (a.kind === 'image')
        return a.hash === b.hash;
    if (a.kind === 'files')
        return a.uris.join('\n') === b.uris.join('\n');
    return a.text === b.text;
}

/**
 * "copy\nfile:///a\nfile:///b" (Nautilus) ou "file:///a\r\nfile:///b" (padrão).
 *
 * @param {GLib.Bytes|null} bytes
 * @returns {string[]}
 */
function parseUris(bytes) {
    if (!bytes)
        return [];
    const text = new TextDecoder().decode(bytes.toArray());
    return text.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && /^[a-z][a-z0-9+.-]*:/i.test(l));
}
