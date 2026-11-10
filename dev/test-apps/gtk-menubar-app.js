#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
// App de TESTE (desenvolvimento) para a camada A do Luma Menu.
//
// Um app GTK4 mínimo com GtkApplication + barra de menus (GMenu). O GTK
// exporta essa barra pelo D-Bus (org.gtk.Menus) e informa o caminho ao
// Mutter — exatamente o que apps GTK reais com menubar fazem. Assim testamos
// a leitura dos menus sem depender de qual app está instalado.
//
// Rodar dentro da sessão aninhada:
//   ./scripts/nested-eval.sh 'GLib.spawn_command_line_async("gjs -m <caminho>/gtk-menubar-app.js"); 1'

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({
    application_id: 'io.github.viniciusbispo19.LumaMenuTest',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

// Registro do que foi ativado (o teste lê o título da janela).
let lastAction = '(nenhuma)';
let window = null;
const log = name => {
    lastAction = name;
    window?.set_title(`Luma Test — ${name}`);
    print(`ACTIVATED ${name}`);
};

function addAction(map, name, callback = () => log(name)) {
    const action = new Gio.SimpleAction({name});
    action.connect('activate', callback);
    map.add_action(action);
    return action;
}

app.connect('startup', () => {
    // Ações de aplicativo ("app.*")
    addAction(app, 'about');
    addAction(app, 'preferences');
    addAction(app, 'quit', () => {
        log('quit');
        app.quit();
    });
    addAction(app, 'new-window');
    const disabled = addAction(app, 'disabled-thing');
    disabled.enabled = false;

    // Ação marcável (com estado booleano)
    const toggle = Gio.SimpleAction.new_stateful('show-grid', null,
        GLib.Variant.new_boolean(true));
    toggle.connect('activate', a => {
        a.set_state(GLib.Variant.new_boolean(!a.get_state().get_boolean()));
        log(`show-grid=${a.get_state().get_boolean()}`);
    });
    app.add_action(toggle);

    // Ação com parâmetro (radio)
    const zoom = Gio.SimpleAction.new_stateful('zoom', GLib.VariantType.new('s'),
        GLib.Variant.new_string('100'));
    zoom.connect('activate', (a, param) => {
        a.set_state(param);
        log(`zoom=${param.get_string()[0]}`);
    });
    app.add_action(zoom);

    app.set_accels_for_action('app.quit', ['<Primary>q']);

    // Barra de menus
    const menubar = new Gio.Menu();

    const file = new Gio.Menu();
    const s1 = new Gio.Menu();
    s1.append('_New Window', 'app.new-window');
    const doc = Gio.MenuItem.new('Open _Document', 'win.open-doc');
    doc.set_attribute_value('accel', GLib.Variant.new_string('<Primary>o'));
    s1.append_item(doc);
    file.append_section(null, s1);
    const recent = new Gio.Menu();
    recent.append('Recent One', 'win.recent-one');
    recent.append('Recent Two', 'win.recent-two');
    file.append_submenu('Open _Recent', recent);
    const s2 = new Gio.Menu();
    s2.append('_Quit', 'app.quit');
    file.append_section(null, s2);
    menubar.append_submenu('_File', file);

    const view = new Gio.Menu();
    view.append('Show _Grid', 'app.show-grid');
    const zoomMenu = new Gio.Menu();
    zoomMenu.append_item(Gio.MenuItem.new('Zoom 100%', 'app.zoom::100'));
    zoomMenu.append_item(Gio.MenuItem.new('Zoom 200%', 'app.zoom::200'));
    view.append_section('Zoom', zoomMenu);
    view.append('Disabled Thing', 'app.disabled-thing');
    menubar.append_submenu('_View', view);

    const help = new Gio.Menu();
    help.append('_About Luma Test', 'app.about');
    help.append('_Preferences', 'app.preferences');
    menubar.append_submenu('_Help', help);

    app.set_menubar(menubar);
});

app.connect('activate', () => {
    window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Luma Test',
        default_width: 480,
        default_height: 300,
        show_menubar: true,
    });
    // Ações de janela ("win.*") — GActionMap da GtkApplicationWindow, que o
    // GTK exporta no caminho da janela.
    addAction(window, 'open-doc');
    addAction(window, 'recent-one');
    addAction(window, 'recent-two');
    window.set_child(new Gtk.Label({label: 'Janela de teste do Luma Menu'}));
    window.present();
});

app.run([]);
void lastAction;
