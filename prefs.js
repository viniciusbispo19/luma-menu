// SPDX-License-Identifier: GPL-3.0-or-later
// Janela de preferências do Luma Menu (libadwaita).
//
// Importante: este arquivo NÃO roda dentro do GNOME Shell. Ele roda num
// processo separado (o app "Extensões"/gnome-extensions-app), com GTK 4 e
// libadwaita. Por isso aqui usamos Gtk/Adw (e não St/Clutter), e não
// podemos importar nada de "resource:///org/gnome/shell/ui/...".
//
// Todas as opções são gravadas no GSettings. A extensão (no Shell) escuta
// "changed::chave" e aplica a mudança na hora — sem reiniciar nada.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {
    ExtensionPreferences, gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SYSTEM_ICONS} from './lib/icons.js';

const GITHUB_URL = 'https://github.com/viniciusbispo19/luma-menu';

export default class LumaMenuPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        window.set_default_size(720, 760);
        window.search_enabled = true;

        window.add(this._generalPage());
        window.add(this._appearancePage());
        window.add(this._menusPage());
        window.add(this._compatibilityPage());
        window.add(this._aboutPage());
    }

    // ----------------------------------------------------------------------
    // Componentes reutilizáveis
    // ----------------------------------------------------------------------

    /** Linha com interruptor ligada direto a uma chave booleana. */
    _switch(key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /** Linha numérica (SpinRow) ligada a uma chave inteira. */
    _spin(key, title, subtitle, min, max, step = 1) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * Lista de opções (ComboRow) ligada a uma chave de texto/enum.
     *
     * @param {string} key
     * @param {string} title
     * @param {[string, string][]} options - pares [valor, rótulo]
     * @param {string} [subtitle]
     */
    _combo(key, title, options, subtitle = '') {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(options.map(([, label]) => label)),
        });
        const sync = () => {
            const index = options.findIndex(([value]) => value === this._settings.get_string(key));
            row.selected = Math.max(0, index);
        };
        sync();
        row.connect('notify::selected', () => {
            const value = options[row.selected]?.[0];
            if (value && value !== this._settings.get_string(key))
                this._settings.set_string(key, value);
        });
        this._settings.connect(`changed::${key}`, sync);
        return row;
    }

    /**
     * Linha de atalho de teclado: mostra o atalho atual e, ao clicar, abre
     * uma janelinha que "escuta" a próxima combinação de teclas.
     */
    _shortcut(key, title, subtitle = '') {
        const label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            label.accelerator = this._settings.get_strv(key)[0] ?? '';
        };
        sync();
        this._settings.connect(`changed::${key}`, sync);

        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(label);
        row.connect('activated', () => this._captureShortcut(row, key));
        return row;
    }

    _captureShortcut(parent, key) {
        const content = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: _('Press the new shortcut'),
            description: _('Esc cancels · Backspace disables the shortcut'),
        });
        const dialog = new Adw.Dialog({
            title: _('Set Shortcut'),
            content_width: 420,
            child: content,
        });
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && !mods) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace && !mods) {
                this._settings.set_strv(key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Ignora teclas que são só modificadores (Ctrl sozinho etc.).
            if (!Gtk.accelerator_valid(keyval, mods) &&
                !(keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35))
                return Gdk.EVENT_STOP;
            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
            this._settings.set_strv(key, [accel]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present(parent);
    }

    // ----------------------------------------------------------------------
    // Páginas
    // ----------------------------------------------------------------------

    _generalPage() {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        const bar = new Adw.PreferencesGroup({title: _('Menu Bar')});
        bar.add(this._switch('show-fallback-menus', _('Standard menus'),
            _('Show File, Edit, View and Window when the app has no menus of its own')));
        bar.add(this._switch('hide-activities', _('Hide the Activities button')));
        bar.add(this._combo('clock-position', _('Clock position'), [
            ['center', _('Center')],
            ['right', _('Right (like macOS)')],
        ]));
        page.add(bar);

        const keys = new Adw.PreferencesGroup({title: _('Keyboard Shortcuts')});
        keys.add(this._shortcut('focus-bar-shortcut', _('Focus the menu bar'),
            _('Opens the app menu; use the arrow keys to navigate')));
        keys.add(this._shortcut('force-quit-shortcut', _('Force Quit')));
        page.add(keys);

        const monitors = new Adw.PreferencesGroup({title: _('Multiple Monitors')});
        monitors.add(new Adw.ActionRow({
            title: _('The menu bar is shown on the primary monitor'),
            subtitle: _('GNOME has a single top bar, on the primary monitor. Showing the menus on every monitor would need a second bar, which this extension does not create.'),
        }));
        page.add(monitors);
        return page;
    }

    _appearancePage() {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        // --- Ícone do sistema: grade com prévia de cada logo ---
        const iconGroup = new Adw.PreferencesGroup({
            title: _('System Icon'),
            description: _('The logo shown in place of the Apple menu'),
        });
        iconGroup.add(this._iconPicker());
        iconGroup.add(this._spin('icon-size', _('Icon size'), _('In pixels'), 14, 22));
        iconGroup.add(this._combo('icon-style', _('Icon style'), [
            ['symbolic', _('Symbolic (follows the theme color)')],
            ['color', _('Color')],
        ]));
        page.add(iconGroup);

        const bar = new Adw.PreferencesGroup({title: _('Menu Bar')});
        bar.add(this._switch('bold-app-name', _('App name in bold')));
        bar.add(this._spin('title-spacing', _('Title spacing'),
            _('Space on each side of a menu title, in pixels'), 2, 16));
        page.add(bar);

        const menus = new Adw.PreferencesGroup({title: _('Drop-down Menus')});
        menus.add(this._combo('shortcut-style', _('Shortcut style'), [
            ['text', _('Text (Ctrl+C)')],
            ['symbols', _('Mac symbols (⌃C)')],
        ]));
        menus.add(this._spin('menu-opacity', _('Opacity'), _('In percent'), 50, 100, 2));
        menus.add(this._spin('menu-radius', _('Corner radius'), _('In pixels'), 0, 16));
        page.add(menus);
        return page;
    }

    /** Grade de botões com o logo de cada distro + Automático + Personalizado. */
    _iconPicker() {
        const iconsDir = this.dir.get_child('icons');
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 8,
            min_children_per_line: 4,
            column_spacing: 6,
            row_spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            homogeneous: true,
        });

        const buttons = new Map();
        const addButton = (id, name, image) => {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
            box.append(image);
            box.append(new Gtk.Label({label: name, css_classes: ['caption'],
                ellipsize: Pango.EllipsizeMode.END}));
            const button = new Gtk.ToggleButton({
                child: box,
                tooltip_text: name,
                css_classes: ['flat'],
            });
            button.connect('clicked', () => {
                if (id === 'custom')
                    this._chooseCustomIcon(flow);
                else
                    this._settings.set_string('system-icon', id);
                sync();
            });
            buttons.set(id, button);
            flow.append(button);
        };

        for (const [id, info] of Object.entries(SYSTEM_ICONS)) {
            const file = iconsDir.get_child(`${id}-symbolic.svg`);
            addButton(id, info.name, new Gtk.Image({
                gicon: new Gio.FileIcon({file}),
                pixel_size: 28,
            }));
        }
        addButton('auto', _('Automatic'), new Gtk.Image({
            icon_name: 'computer-symbolic', pixel_size: 28,
        }));
        addButton('custom', _('Custom…'), new Gtk.Image({
            icon_name: 'document-open-symbolic', pixel_size: 28,
        }));

        const sync = () => {
            const current = this._settings.get_string('system-icon');
            for (const [id, button] of buttons)
                button.active = id === current;
        };
        sync();
        this._settings.connect('changed::system-icon', sync);

        const row = new Adw.PreferencesRow({activatable: false, child: flow});
        return row;
    }

    async _chooseCustomIcon(parentWidget) {
        const filter = new Gtk.FileFilter({name: _('Images (SVG, PNG)')});
        filter.add_mime_type('image/svg+xml');
        filter.add_mime_type('image/png');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({
            title: _('Choose an Icon'),
            filters,
            default_filter: filter,
        });
        try {
            const file = await dialog.open(parentWidget.get_root(), null);
            this._settings.set_string('custom-icon-path', file.get_path());
            this._settings.set_string('system-icon', 'custom');
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                console.warn(`[Luma Menu] escolhendo ícone: ${e.message}`);
        }
    }

    _menusPage() {
        const page = new Adw.PreferencesPage({
            title: _('Menus'),
            icon_name: 'view-list-symbolic',
        });

        const std = new Adw.PreferencesGroup({
            title: _('Standard Menus'),
            description: _('Used when the app does not export menus of its own'),
        });
        std.add(this._switch('show-file-menu', _('File')));
        std.add(this._switch('show-edit-menu', _('Edit')));
        std.add(this._switch('show-view-menu', _('View')));
        std.add(this._switch('show-window-menu', _('Window')));
        std.add(this._switch('show-help-menu', _('Help')));
        std.add(this._switch('help-search', _('Search field in the Help menu'),
            _('Searches every menu item of the current app')));
        page.add(std);

        const sys = new Adw.PreferencesGroup({title: _('System Menu')});
        sys.add(this._switch('system-menu-show-software', _('Software Center…')));
        sys.add(this._switch('system-menu-show-recent', _('Recent Items')));
        sys.add(this._switch('system-menu-show-force-quit', _('Force Quit…')));
        sys.add(this._switch('system-menu-show-power', _('Suspend, Restart and Shut Down')));
        page.add(sys);
        return page;
    }

    _compatibilityPage() {
        const page = new Adw.PreferencesPage({
            title: _('Compatibility'),
            icon_name: 'applications-engineering-symbolic',
        });

        const dbus = new Adw.PreferencesGroup({title: _('Apps That Use DBusMenu')});
        dbus.add(this._switch('enable-registrar', _('Read menus from Qt, Electron and similar apps'),
            _('Provides the com.canonical.AppMenu.Registrar service. Works with apps running through XWayland; apps that were already open need to be restarted.')));
        page.add(dbus);

        page.add(this._ignoredAppsGroup());

        const debug = new Adw.PreferencesGroup({title: _('Troubleshooting')});
        debug.add(this._switch('debug', _('Debug mode'),
            _('Writes details to the system journal (journalctl)')));
        page.add(debug);
        return page;
    }

    /** Lista editável de apps que usam só os menus padrão. */
    _ignoredAppsGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Ignored Apps'),
            description: _('These apps always use the standard menus. Use the app ID (e.g. org.gnome.TextEditor) or the window class (WM_CLASS).'),
        });

        const entry = new Adw.EntryRow({
            title: _('Add app'),
            show_apply_button: true,
        });
        entry.connect('apply', () => {
            const value = entry.text.trim();
            const list = this._settings.get_strv('ignored-apps');
            if (value && !list.includes(value))
                this._settings.set_strv('ignored-apps', [...list, value]);
            entry.text = '';
        });
        group.add(entry);

        let rows = [];
        const sync = () => {
            for (const row of rows)
                group.remove(row);
            rows = this._settings.get_strv('ignored-apps').map(app => {
                const row = new Adw.ActionRow({title: app});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    this._settings.set_strv('ignored-apps',
                        this._settings.get_strv('ignored-apps').filter(a => a !== app));
                });
                row.add_suffix(remove);
                group.add(row);
                return row;
            });
        };
        sync();
        this._settings.connect('changed::ignored-apps', sync);
        return group;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
        });
        box.append(new Gtk.Image({
            gicon: new Gio.FileIcon({file: this.dir.get_child('icons').get_child('fedora-symbolic.svg')}),
            pixel_size: 64,
        }));
        box.append(new Gtk.Label({label: 'Luma Menu', css_classes: ['title-1']}));
        box.append(new Gtk.Label({
            label: _('A macOS-style global menu bar for GNOME'),
            css_classes: ['dim-label'],
        }));
        header.add(box);
        page.add(header);

        const info = new Adw.PreferencesGroup();
        info.add(new Adw.ActionRow({
            title: _('Version'),
            subtitle: String(this.metadata['version-name'] ?? this.metadata.version ?? '—'),
        }));
        info.add(new Adw.ActionRow({title: _('Author'), subtitle: 'Vinicius Bispo'}));
        const link = new Adw.ActionRow({
            title: _('Source code'),
            subtitle: GITHUB_URL,
            activatable: true,
        });
        link.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        link.connect('activated', () => {
            new Gtk.UriLauncher({uri: GITHUB_URL}).launch(link.get_root(), null, null);
        });
        info.add(link);
        info.add(new Adw.ActionRow({
            title: _('License'),
            subtitle: _('GNU General Public License, version 3 or later'),
        }));
        page.add(info);

        return page;
    }
}
