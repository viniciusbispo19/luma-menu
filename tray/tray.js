// SPDX-License-Identifier: GPL-3.0-or-later
// Bandeja de arquivos do Luma Menu: você solta arquivos aqui e depois os
// arrasta para onde quiser (outra pasta, um e-mail, um chat…).
//
// Por que uma JANELA separada, e não algo dentro do GNOME Shell?
// No Wayland, arrastar e soltar acontece entre APPS: o Shell só fica sabendo
// que tem algo sendo arrastado por cima dele, mas não recebe os arquivos — e
// também não consegue "entregar" um arquivo arrastado para um app. Uma janela
// GTK 4 consegue as duas coisas. (O Isle faz igual, com um programa em Rust;
// aqui é GJS, sem compilar nada.)
//
// Não é um serviço em segundo plano: a extensão abre esta janela quando você
// arrasta um arquivo até o relógio (ou pelo botão da prateleira) e ela fecha
// quando você a fecha. A lista fica salva em ~/.local/share/luma-menu/tray.json
// (só os CAMINHOS: os arquivos continuam onde estão).
//
// Uso: gjs -m tray.js <pasta-de-traduções>

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import Gettext from 'gettext';
import {programArgs} from 'system';

const APP_ID = 'io.github.viniciusbispo19.LumaMenu.Tray';
const DOMAIN = 'luma-menu';

if (programArgs[0])
    Gettext.bindtextdomain(DOMAIN, programArgs[0]);
const _ = text => Gettext.dgettext(DOMAIN, text);

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');

const LIST_FILE = Gio.File.new_for_path(
    GLib.build_filenamev([GLib.get_user_data_dir(), 'luma-menu', 'tray.json']));

const CSS = `
.luma-tray-drop { border-radius: 12px; transition: background 150ms; }
.luma-tray-drop.hover { background: alpha(@accent_bg_color, 0.18); }
.luma-tray-tile { padding: 8px 4px; border-radius: 10px; }
.luma-tray-tile:hover { background: alpha(currentColor, 0.08); }
.luma-tray-tile .remove { min-width: 20px; min-height: 20px; padding: 0; }
`;

/**
 * Conteúdo de arraste com uma lista de arquivos, no formato universal
 * "text/uri-list" (um endereço file:// por linha).
 *
 * Por que não o Gdk.FileList direto? Com ele, o GTK 4 oferece primeiro o
 * formato do PORTAL de transferência de arquivos; apps Qt/Electron/XWayland
 * não o entendem e, sem o portal funcionando, até o Arquivos recusa o drop.
 * A lista de endereços todo app entende (o Arquivos também).
 */
function fileListContent(files) {
    const text = `${files.map(f => f.get_uri()).join('\r\n')}\r\n`;
    return Gdk.ContentProvider.new_for_bytes('text/uri-list', new TextEncoder().encode(text));
}

const TrayWindow = GObject.registerClass(
class TrayWindow extends Adw.ApplicationWindow {
    _init(app) {
        super._init({
            application: app,
            title: _('File Tray'),
            default_width: 320,
            default_height: 360,
            resizable: false,
        });
        this._files = []; // Gio.File

        // Só o botão de fechar (minimizar/maximizar não fazem sentido aqui).
        const header = new Adw.HeaderBar({decoration_layout: ':close'});
        this._clearButton = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            tooltip_text: _('Clear'),
        });
        this._clearButton.connect('clicked', () => this._setFiles([]));
        header.pack_start(this._clearButton);

        // "Arrastar tudo": um botão que é ele mesmo a origem do arraste.
        this._allButton = new Gtk.Button({
            icon_name: 'edit-select-all-symbolic',
            tooltip_text: _('Drag all files from here'),
        });
        this._allButton.add_controller(this._dragSource(() => [...this._files]));
        header.pack_end(this._allButton);

        this._empty = new Adw.StatusPage({
            icon_name: 'folder-download-symbolic',
            title: _('Drop Files Here'),
            description: _('They stay here until you drag them somewhere else'),
            vexpand: true,
        });
        this._empty.add_css_class('compact');

        this._grid = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 3,
            min_children_per_line: 3,
            homogeneous: true,
            valign: Gtk.Align.START,
            row_spacing: 4,
            column_spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        this._stack = new Gtk.Stack();
        this._stack.add_named(this._empty, 'empty');
        this._stack.add_named(new Gtk.ScrolledWindow({
            child: this._grid,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        }), 'files');

        const dropArea = new Gtk.Box({css_classes: ['luma-tray-drop'], margin_start: 6, margin_end: 6, margin_bottom: 6});
        this._stack.hexpand = true;
        dropArea.append(this._stack);
        const target = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.COPY);
        target.connect('enter', () => {
            dropArea.add_css_class('hover');
            return Gdk.DragAction.COPY;
        });
        target.connect('leave', () => dropArea.remove_css_class('hover'));
        target.connect('drop', (_t, value) => {
            dropArea.remove_css_class('hover');
            const dropped = value?.get_files?.() ?? [];
            const known = new Set(this._files.map(f => f.get_uri()));
            this._setFiles([...this._files, ...dropped.filter(f => !known.has(f.get_uri()))]);
            return dropped.length > 0;
        });
        dropArea.add_controller(target);

        const toolbar = new Adw.ToolbarView({content: dropArea});
        toolbar.add_top_bar(header);
        this.set_content(toolbar);

        this._load();
    }

    async _load() {
        try {
            const [bytes] = await LIST_FILE.load_contents_async(null);
            const paths = JSON.parse(new TextDecoder().decode(bytes))?.files ?? [];
            const files = paths.map(p => Gio.File.new_for_path(p)).filter(f => f.query_exists(null));
            this._setFiles([...files, ...this._files], false);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e, 'Luma Menu (bandeja): lendo a lista');
            this._setFiles(this._files, false);
        }
    }

    async _save() {
        try {
            await makeDirectories(LIST_FILE.get_parent());
            const data = JSON.stringify({files: this._files.map(f => f.get_path()).filter(Boolean)});
            await LIST_FILE.replace_contents_async(new TextEncoder().encode(data), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            logError(e, 'Luma Menu (bandeja): gravando a lista');
        }
    }

    _setFiles(files, save = true) {
        this._files = files;
        this._grid.remove_all();
        for (const file of files)
            this._grid.append(this._tile(file));
        this._stack.visible_child_name = files.length ? 'files' : 'empty';
        this._clearButton.sensitive = this._allButton.sensitive = files.length > 0;
        if (save)
            this._save();
    }

    /**
     * Origem de arraste. Se o arraste der certo (o app aceitou), os arquivos
     * saem da bandeja: já foram entregues. Cancelado (Esc, soltou no vazio):
     * ficam. O GTK avisa "drag-cancel" ANTES de "drag-end".
     *
     * @param {Function} getFiles - () => Gio.File[]
     * @param {Gtk.Image} [image] - ícone que acompanha o ponteiro
     */
    _dragSource(getFiles, image = null) {
        const source = new Gtk.DragSource({actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE});
        let files = [];
        let cancelled = false;
        source.connect('prepare', () => {
            files = getFiles();
            cancelled = false;
            return files.length ? fileListContent(files) : null;
        });
        source.connect('drag-begin', (_s, drag) => {
            if (image?.gicon)
                Gtk.DragIcon.get_for_drag(drag).child = new Gtk.Image({gicon: image.gicon, pixel_size: 48});
        });
        source.connect('drag-cancel', () => {
            cancelled = true;
            return false;
        });
        source.connect('drag-end', () => {
            if (!cancelled)
                this._delivered(files);
        });
        return source;
    }

    _delivered(files) {
        const gone = new Set(files.map(f => f.get_uri()));
        this._setFiles(this._files.filter(f => !gone.has(f.get_uri())));
    }

    _tile(file) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            css_classes: ['luma-tray-tile'],
            tooltip_text: file.get_path() ?? file.get_uri(),
        });
        const image = new Gtk.Image({icon_name: 'text-x-generic', pixel_size: 48});
        const label = new Gtk.Label({
            label: file.get_basename() ?? '',
            ellipsize: Pango.EllipsizeMode.MIDDLE,
            max_width_chars: 10,
            css_classes: ['caption'],
        });
        const remove = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            css_classes: ['circular', 'flat', 'remove'],
            tooltip_text: _('Remove from the tray'),
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
        });
        remove.connect('clicked', () => this._setFiles(this._files.filter(f => !f.equal(file))));
        const overlay = new Gtk.Overlay({child: image});
        overlay.add_overlay(remove);
        box.append(overlay);
        box.append(label);

        // Ícone (ou miniatura, se o GNOME já tiver uma) sem travar a janela.
        file.query_info_async('standard::icon,standard::display-name,thumbnail::path',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null).then(info => {
                label.label = info.get_display_name();
                const thumb = info.get_attribute_byte_string('thumbnail::path');
                if (thumb)
                    image.set_from_file(thumb);
                else if (info.get_icon())
                    image.gicon = info.get_icon();
            }).catch(() => {});

        // Arrastar o arquivo para fora.
        box.add_controller(this._dragSource(() => [file], image));

        // Clique duplo abre o arquivo no app padrão.
        const click = new Gtk.GestureClick();
        click.connect('pressed', (_g, n) => {
            if (n === 2)
                new Gtk.FileLauncher({file}).launch(this, null, null);
        });
        box.add_controller(click);
        return box;
    }
});

async function makeDirectories(dir) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await makeDirectories(dir.get_parent());
        await makeDirectories(dir);
    }
}

const app = new Adw.Application({application_id: APP_ID});
app.connect('startup', () => {
    const css = new Gtk.CssProvider();
    css.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
});
// Abrir de novo com a janela já aberta só a traz para a frente (o
// Gtk.Application garante uma única instância).
app.connect('activate', () => {
    (app.active_window ?? new TrayWindow(app)).present();
});
app.run([]);
