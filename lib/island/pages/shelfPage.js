// SPDX-License-Identifier: GPL-3.0-or-later
// Página Prateleira do pop-up do relógio: o histórico da área de
// transferência e o atalho para a bandeja de arquivos.
//
//   [ 🔍 Buscar…                              ] [⏸] [🗑]
//   📌 senha do wi-fi da casa                       📌 ×   ← fixado
//   🔗 https://github.com/…                          📌 ×
//   🖼 [miniatura]  Imagem · há 2 min                📌 ×
//   📄 relatorio.pdf  ·  1 arquivo                   📌 ×
//   ───────────────────────────────────────────────────────
//   📥 Bandeja de arquivos — arraste arquivos até o relógio
//
// Clicar (ou Enter) põe o item de volta na área de transferência e, se a
// opção estiver ligada, cola direto no app. Teclado: digitar busca, ↓/↑
// andam pela lista, Delete apaga, Esc fecha.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {T, formatFileCount, formatRelativeTime} from '../strings.js';
import {logError} from '../../util.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const THUMB_WIDTH = 120;
const THUMB_HEIGHT = 56;
const PREVIEW_CHARS = 160;

export class ShelfPage {
    /**
     * @param {Gio.Settings} settings
     * @param {object} ctx - {clipboard, pasteItem(id), openTray()}
     */
    constructor(settings, ctx) {
        this.id = 'shelf';
        this._settings = settings;
        this._history = ctx.clipboard;
        this._ctx = ctx;
        this._visible = false;
        this._rows = [];
        this._thumbs = new Map(); // id → St.ImageContent
        this._cancellable = new Gio.Cancellable();

        this.actor = new St.BoxLayout({
            style_class: 'luma-shelf',
            orientation: Clutter.Orientation.VERTICAL,
        });

        // ----- Busca + pausar + limpar -----
        const top = new St.BoxLayout({style_class: 'luma-shelf-top'});
        this._search = new St.Entry({
            style_class: 'luma-reminders-entry luma-shelf-search',
            hint_text: T.searchClipboard,
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'luma-shelf-search-icon'}),
        });
        this._search.clutter_text.connect('text-changed', () => this._rebuild());
        this._search.clutter_text.connect('activate', () => this._rows[0]?.activate());
        this._search.clutter_text.add_action(this._keys(key => {
            if (key === Clutter.KEY_Down) {
                this._rows[0]?.button.grab_key_focus();
                return true;
            }
            return false;
        }));
        top.add_child(this._search);

        this._pause = this._iconButton('media-playback-pause-symbolic', T.pauseHistory,
            () => {
                this._history.paused = !this._history.paused;
            });
        top.add_child(this._pause);
        this._clear = this._iconButton('edit-clear-all-symbolic', T.clearUnpinned,
            () => this._history.clear());
        top.add_child(this._clear);
        this.actor.add_child(top);

        this._pausedNote = new St.Label({
            style_class: 'luma-shelf-note',
            text: T.historyPaused,
            visible: false,
        });
        this.actor.add_child(this._pausedNote);

        // ----- Lista -----
        this._list = new St.BoxLayout({
            style_class: 'luma-shelf-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'luma-shelf-scroll',
            child: this._list,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this.actor.add_child(this._scroll);
        this._empty = new St.Label({
            style_class: 'luma-island-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._empty);

        // ----- Bandeja de arquivos -----
        const tray = new St.Button({
            style_class: 'luma-shelf-tray',
            can_focus: true,
            x_expand: true,
        });
        const trayBox = new St.BoxLayout();
        trayBox.add_child(new St.Icon({icon_name: 'folder-download-symbolic', style_class: 'luma-shelf-tray-icon'}));
        const trayText = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        trayText.add_child(new St.Label({text: T.fileTray, style_class: 'luma-shelf-tray-title'}));
        trayText.add_child(new St.Label({text: T.fileTrayHint, style_class: 'luma-shelf-tray-hint'}));
        trayBox.add_child(trayText);
        tray.set_child(trayBox);
        tray.connect('clicked', () => ctx.openTray());
        this.actor.add_child(tray);

        this._history.connectObject('changed', () => this._rebuild(), this);
        this.actor.connect('destroy', () => {
            this._cancellable.cancel();
            this._history.disconnectObject(this);
        });
    }

    get title() {
        return T.shelf;
    }

    get isLive() {
        return false;
    }

    show() {
        this._visible = true;
        this._rebuild();
    }

    hide() {
        this._visible = false;
        this._search.text = '';
        this._list.destroy_all_children();
        this._rows = [];
    }

    /** Atalho do teclado: começa já digitando na busca. */
    focusSearch() {
        this._search.grab_key_focus();
    }

    _iconButton(iconName, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'luma-shelf-icon-button',
            child: new St.Icon({icon_name: iconName}),
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    /** Ação de teclado: handler(keyval) devolve true se tratou a tecla. */
    _keys(handler) {
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            return handler(symbol) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });
        return keys;
    }

    _rebuild() {
        const paused = this._history.paused;
        this._pause.child.icon_name = paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._pause.accessible_name = paused ? T.resumeHistory : T.pauseHistory;
        this._pausedNote.visible = paused;
        if (!this._visible)
            return;

        const query = normalize(this._search.text.trim());
        const all = this._history.items;
        const items = query ? all.filter(i => normalize(searchText(i)).includes(query)) : all;
        this._clear.reactive = all.some(i => !i.pinned);
        this._clear.opacity = this._clear.reactive ? 255 : 100;

        // Miniaturas de itens que saíram não ficam na memória.
        for (const id of this._thumbs.keys()) {
            if (!all.some(i => i.id === id))
                this._thumbs.delete(id);
        }

        const focusedIndex = this._rows.findIndex(r => r.button.has_key_focus());
        this._list.destroy_all_children();
        this._rows = items.map(item => this._buildRow(item));
        this._rows.forEach(r => this._list.add_child(r.box));
        // Depois de apagar com Delete, o foco fica na linha seguinte.
        if (focusedIndex >= 0 && this._rows.length)
            this._rows[Math.min(focusedIndex, this._rows.length - 1)].button.grab_key_focus();

        this._scroll.visible = items.length > 0;
        this._empty.visible = items.length === 0;
        this._empty.text = query ? T.noMatches : T.nothingCopied;
    }

    _buildRow(item) {
        const box = new St.BoxLayout({style_class: 'luma-shelf-row'});
        if (item.pinned)
            box.add_style_class_name('pinned');

        const button = new St.Button({
            style_class: 'luma-shelf-item',
            can_focus: true,
            x_expand: true,
        });
        const content = new St.BoxLayout({x_expand: true});
        content.add_child(this._preview(item));
        const texts = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({style_class: 'luma-shelf-item-title', text: titleOf(item)});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(title);
        const subtitle = new St.Label({
            style_class: 'luma-shelf-item-subtitle',
            text: [subtitleOf(item), formatRelativeTime(item.time)].filter(Boolean).join(' · '),
        });
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        texts.add_child(subtitle);
        content.add_child(texts);
        button.set_child(content);

        const activate = () => this._ctx.pasteItem(item.id);
        button.connect('clicked', activate);
        button.add_action(this._keys(key => {
            const index = this._rows.findIndex(r => r.button === button);
            if (key === Clutter.KEY_Down) {
                this._rows[index + 1]?.button.grab_key_focus();
                return true;
            }
            if (key === Clutter.KEY_Up) {
                (this._rows[index - 1]?.button ?? this._search).grab_key_focus();
                return true;
            }
            if (key === Clutter.KEY_Delete || key === Clutter.KEY_KP_Delete) {
                this._history.remove(item.id);
                return true;
            }
            return false;
        }));
        box.add_child(button);

        const pin = this._iconButton('view-pin-symbolic',
            item.pinned ? T.unpin : T.pin, () => this._history.togglePin(item.id));
        pin.add_style_class_name('luma-shelf-pin');
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        box.add_child(pin);
        box.add_child(this._iconButton('window-close-symbolic', T.remove,
            () => this._history.remove(item.id)));
        return {box, button, activate};
    }

    _preview(item) {
        if (item.kind === 'image') {
            // Começa quadrada; a largura acompanha a proporção da imagem
            // quando a miniatura carrega.
            const thumb = new St.Widget({
                style_class: 'luma-shelf-thumb',
                width: THUMB_HEIGHT,
                height: THUMB_HEIGHT,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const cached = this._thumbs.get(item.id);
            if (cached)
                setThumb(thumb, cached);
            else
                this._loadThumb(item, thumb);
            return thumb;
        }
        const icon = {
            text: 'edit-paste-symbolic',
            link: 'web-browser-symbolic',
            files: 'folder-documents-symbolic',
        }[item.kind];
        return new St.Icon({
            icon_name: icon,
            style_class: 'luma-shelf-item-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    /** Miniatura sem travar o Shell: o GdkPixbuf lê e reduz a imagem aos poucos. */
    async _loadThumb(item, actor) {
        try {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const stream = await Gio.File.new_for_path(item.image)
                .read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream,
                THUMB_WIDTH * scale, THUMB_HEIGHT * scale, true, this._cancellable);
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
            const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
                pixbuf.read_pixel_bytes(),
                pixbuf.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.width, pixbuf.height, pixbuf.rowstride);
            this._thumbs.set(item.id, content);
            if (!this._cancellable.is_cancelled() && actor.get_stage())
                setThumb(actor, content);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'miniatura do histórico');
        }
    }

    destroy() {
        this.actor.destroy();
    }
}

/** Mostra a miniatura com a largura na proporção da imagem (até o máximo). */
function setThumb(actor, content) {
    const [ok, w, h] = content.get_preferred_size();
    if (ok && h > 0)
        actor.width = Math.round(Math.min(THUMB_WIDTH, THUMB_HEIGHT * w / h));
    actor.content = content;
}

function titleOf(item) {
    if (item.kind === 'image')
        return T.image;
    if (item.kind === 'files') {
        const first = Gio.File.new_for_uri(item.uris[0]);
        return first.get_basename() ?? item.uris[0];
    }
    // Espaços e quebras repetidos viram um só; texto enorme é cortado.
    return item.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

function subtitleOf(item) {
    if (item.kind === 'files')
        return formatFileCount(item.uris.length);
    if (item.kind === 'link')
        return T.link;
    return '';
}

function searchText(item) {
    if (item.kind === 'files')
        return item.uris.map(u => Gio.File.new_for_uri(u).get_parse_name()).join(' ');
    if (item.kind === 'image')
        return T.image;
    return item.text;
}

/** Busca sem ligar para acentos e maiúsculas. */
function normalize(text) {
    return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
