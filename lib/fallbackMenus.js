// SPDX-License-Identifier: GPL-3.0-or-later
// Camada D: menus padrão no estilo macOS (Arquivo, Editar, Visualizar, Janela,
// Ajuda) para QUALQUER janela — usados quando o app não exporta menus próprios.
//
// Cada item escolhe COMO agir, do mais confiável ao menos:
//   1. GAction do app (camada C)  → o app faz exatamente o que o item diz;
//   2. API do Mutter              → minimizar, maximizar, tela cheia, fechar…
//   3. Atalho sintetizado         → Ctrl+C, Ctrl+S… (convenções quase
//                                   universais; não garantido em todo app).
// Se nenhum caminho existe (ex.: não há janela), o item fica cinza.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    bringAllToFront, closeAllWindows, closeWindow, getAppWindows, launchApp,
    lookupApp, moveToHalf, moveToNextMonitor, moveToWorkspace, toggleAbove,
    toggleFullscreen, toggleMaximize,
} from './actions.js';
import {
    documentsOpenedBy, loadRecentDocuments, openDocument, openDocumentWith,
} from './recentItems.js';

// ---------------------------------------------------------------------------
// Perfis de atalho: alguns apps usam atalhos diferentes do padrão.
// ---------------------------------------------------------------------------

// Terminais: Ctrl+C interrompe o programa em execução, então copiar/colar
// usam Ctrl+Shift. "Recortar" e "Colar sem formatação" não fazem sentido.
const TERMINAL = {
    cut: null,
    copy: '<Control><Shift>c',
    paste: '<Control><Shift>v',
    pastePlain: null,
    selectAll: '<Control><Shift>a',
    newTab: '<Control><Shift>t',
    newWindow: '<Control><Shift>n',
    find: '<Control><Shift>f',
    findNext: '<Control><Shift>g',
    findPrevious: '<Control><Shift>h',
    replace: null,
    undo: null,
    redo: null,
    save: null,
    saveAs: null,
    open: null,
};

const PROFILES = {
    'org.gnome.ptyxis': TERMINAL,
    'org.gnome.terminal': TERMINAL,
    'org.gnome.console': TERMINAL,
    'org.kde.konsole': TERMINAL,
    'kitty': TERMINAL,
    'alacritty': TERMINAL,
    'com.mitchellh.ghostty': TERMINAL,
    'org.wezfurlong.wezterm': TERMINAL,
    'foot': TERMINAL,
    'xterm': TERMINAL,
};

/** Atalhos padrão (Linux/GNOME) de cada comando. */
export const DEFAULT_ACCELS = {
    newWindow: '<Control>n',
    newTab: '<Control>t',
    open: '<Control>o',
    closeWindow: '<Control>w',
    closeAll: '<Control><Shift>w',
    save: '<Control>s',
    saveAs: '<Control><Shift>s',
    print: '<Control>p',
    undo: '<Control>z',
    redo: '<Control><Shift>z',
    cut: '<Control>x',
    copy: '<Control>c',
    paste: '<Control>v',
    pastePlain: '<Control><Shift>v',
    delete: 'Delete',
    selectAll: '<Control>a',
    find: '<Control>f',
    findNext: '<Control>g',
    findPrevious: '<Control><Shift>g',
    replace: '<Control>h',
    emoji: '<Control>period',
    sidebar: 'F9',
    zoomIn: '<Control>plus',
    zoomOut: '<Control>minus',
    zoomReset: '<Control>0',
    fullscreen: 'F11',
    minimize: '<Super>h',
    help: 'F1',
    shortcuts: '<Control>question',
};

/**
 * Perfil de atalhos do app (procura pelo ID do .desktop e pelo WM_CLASS).
 *
 * @param {Shell.App|null} app
 * @param {Meta.Window|null} window
 * @returns {object}
 */
function profileFor(app, window) {
    const keys = [
        app?.get_id()?.replace(/\.desktop$/, ''),
        window?.get_wm_class(),
        window?.get_wm_class_instance(),
    ].filter(Boolean).map(k => k.toLowerCase());
    for (const key of keys) {
        if (PROFILES[key])
            return PROFILES[key];
    }
    return {};
}

/** Janela é de um app GTK (aceita Ctrl+. para emoji)? */
function isGtkWindow(window) {
    return Boolean(window?.get_gtk_application_id() || window?.get_gtk_unique_bus_name());
}

// ---------------------------------------------------------------------------
// Construção dos menus
// ---------------------------------------------------------------------------

export class FallbackMenus {
    /**
     * @param {object} ctx
     * @param {Shell.App|null} ctx.app
     * @param {Meta.Window|null} ctx.window
     * @param {boolean} ctx.isDesktop
     * @param {AppActions} ctx.actions
     * @param {VirtualKeyboard} ctx.keyboard
     * @param {string|null} [ctx.helpId] - manual do app, já procurado (findHelpId)
     */
    constructor(ctx) {
        this._ctx = ctx;
        this._profile = profileFor(ctx.app, ctx.window);
    }

    /**
     * Item genérico: GAction se existir; senão atalho sintetizado (se há
     * janela e o perfil do app tem esse atalho); senão cinza.
     *
     * @param {string} key - comando (chave de DEFAULT_ACCELS/KNOWN_ACTIONS)
     * @param {string} label
     * @param {object} [extra] - campos extras do nó
     * @returns {object} nó do menu
     */
    _cmd(key, label, extra = {}) {
        const {actions, window, keyboard} = this._ctx;
        const accel = key in this._profile ? this._profile[key] : DEFAULT_ACCELS[key];
        const viaAction = actions.node(key, {label, accel: accel ?? DEFAULT_ACCELS[key], ...extra});
        if (viaAction)
            return viaAction;
        if (!accel || !window)
            return {label, accel: DEFAULT_ACCELS[key], sensitive: false, ...extra};
        return {label, accel, activate: () => keyboard.send(accel), ...extra};
    }

    /** @returns {{title: string, build: Function}[]} os menus, na ordem */
    getMenus(settings) {
        const menus = [];
        if (settings.get_boolean('show-file-menu'))
            menus.push({id: 'file', title: _('File'), build: () => this.buildFile()});
        if (settings.get_boolean('show-edit-menu'))
            menus.push({id: 'edit', title: _('Edit'), build: () => this.buildEdit()});
        if (settings.get_boolean('show-view-menu'))
            menus.push({id: 'view', title: _('View'), build: () => this.buildView()});
        if (settings.get_boolean('show-window-menu'))
            menus.push({id: 'window', title: _('Window'), build: () => this.buildWindow()});
        return menus;
    }

    buildFile() {
        const {app, window, actions} = this._ctx;

        // "Nova Janela": GAction → Shell (abre nova instância) → atalho.
        let newWindow = actions.node('newWindow', {label: _('New Window'), accel: DEFAULT_ACCELS.newWindow});
        if (!newWindow && app?.can_open_new_window()) {
            newWindow = {
                label: _('New Window'),
                accel: this._profile.newWindow ?? DEFAULT_ACCELS.newWindow,
                activate: () => app.open_new_window(-1),
            };
        }
        newWindow ??= this._cmd('newWindow', _('New Window'));

        return [
            newWindow,
            this._cmd('newTab', _('New Tab')),
            this._cmd('open', _('Open…')),
            {
                label: _('Open Recent'),
                sensitive: Boolean(app?.app_info),
                children: () => this._buildOpenRecent(),
            },
            {separator: true},
            {
                label: _('Close Window'),
                accel: DEFAULT_ACCELS.closeWindow,
                sensitive: Boolean(window),
                activate: () => closeWindow(window),
            },
            {
                label: _('Close All'),
                accel: DEFAULT_ACCELS.closeAll,
                sensitive: getAppWindows(app).length > 0,
                activate: () => closeAllWindows(app),
            },
            this._cmd('save', _('Save')),
            this._cmd('saveAs', _('Save As…')),
            {separator: true},
            this._cmd('print', _('Print…')),
        ];
    }

    async _buildOpenRecent() {
        const {app} = this._ctx;
        const docs = await loadRecentDocuments(null, documentsOpenedBy(app));
        if (!docs.length)
            return [{label: _('No recent documents'), sensitive: false}];
        return docs.map(doc => ({
            label: doc.name,
            icon: doc.icon,
            activate: () => openDocumentWith(app, doc.uri),
        }));
    }

    buildEdit() {
        const {window} = this._ctx;

        // Emoji: apps GTK abrem o seletor de emoji com Ctrl+. ; nos outros,
        // abrimos o app Caracteres (se instalado).
        let emoji;
        if (isGtkWindow(window)) {
            emoji = this._cmd('emoji', _('Emoji & Symbols'));
        } else {
            emoji = {
                label: _('Emoji & Symbols'),
                sensitive: lookupApp('org.gnome.Characters.desktop') !== null,
                activate: () => launchApp('org.gnome.Characters.desktop'),
            };
        }

        return [
            this._cmd('undo', _('Undo')),
            this._cmd('redo', _('Redo')),
            {separator: true},
            this._cmd('cut', _('Cut')),
            this._cmd('copy', _('Copy')),
            this._cmd('paste', _('Paste')),
            this._cmd('pastePlain', _('Paste Without Formatting')),
            this._cmd('delete', _('Delete')),
            this._cmd('selectAll', _('Select All')),
            {separator: true},
            {
                label: _('Find'),
                sensitive: Boolean(window),
                children: () => [
                    this._cmd('find', _('Find…')),
                    this._cmd('findNext', _('Find Next')),
                    this._cmd('findPrevious', _('Find Previous')),
                    this._cmd('replace', _('Find and Replace…')),
                ],
            },
            {separator: true},
            emoji,
        ];
    }

    buildView() {
        const {window, actions} = this._ctx;
        const fullscreen = window?.is_fullscreen() ?? false;
        const fullscreenLabel = fullscreen ? _('Exit Full Screen') : _('Enter Full Screen');

        // Tela cheia: GAction do app (se tiver) → Mutter (funciona sempre).
        const fullscreenNode = actions.node('fullscreen', {
            label: fullscreenLabel,
            accel: DEFAULT_ACCELS.fullscreen,
            checked: null,
        }) ?? {
            label: fullscreenLabel,
            accel: DEFAULT_ACCELS.fullscreen,
            sensitive: Boolean(window),
            activate: () => toggleFullscreen(window),
        };
        delete fullscreenNode.checked;

        return [
            this._cmd('sidebar', _('Show/Hide Sidebar')),
            {separator: true},
            this._cmd('zoomIn', _('Zoom In')),
            this._cmd('zoomOut', _('Zoom Out')),
            this._cmd('zoomReset', _('Actual Size')),
            {separator: true},
            fullscreenNode,
        ];
    }

    buildWindow() {
        const {app, window, keyboard} = this._ctx;
        const hasWindow = Boolean(window);
        const wm = global.workspace_manager;
        const nWorkspaces = wm.get_n_workspaces();
        const currentWs = window?.get_workspace()?.index() ?? -1;

        const workspaces = [];
        for (let i = 0; i < nWorkspaces; i++) {
            workspaces.push({
                label: _('Workspace %d').format(i + 1),
                checked: i === currentWs,
                sensitive: hasWindow && i !== currentWs,
                activate: () => moveToWorkspace(window, i),
            });
        }

        const appWindows = app ? getAppWindows(app) : [];
        const windowItems = appWindows.map(w => ({
            label: w.get_title() || app.get_name(),
            checked: w === window,
            activate: () => Main.activateWindow(w),
        }));

        return [
            {
                label: _('Minimize'),
                accel: DEFAULT_ACCELS.minimize,
                sensitive: hasWindow && window.can_minimize(),
                activate: () => window.minimize(),
            },
            {
                label: _('Zoom'),
                sensitive: hasWindow && (window.can_maximize() || window.is_maximized()),
                activate: () => toggleMaximize(window),
            },
            {separator: true},
            {
                label: _('Move Window to Left Side of Screen'),
                accel: '<Super>Left',
                sensitive: hasWindow && window.allows_resize(),
                activate: () => moveToHalf(window, 'left', keyboard),
            },
            {
                label: _('Move Window to Right Side of Screen'),
                accel: '<Super>Right',
                sensitive: hasWindow && window.allows_resize(),
                activate: () => moveToHalf(window, 'right', keyboard),
            },
            {
                label: _('Move to Next Display'),
                visible: global.display.get_n_monitors() > 1,
                sensitive: hasWindow,
                activate: () => moveToNextMonitor(window),
            },
            {
                label: _('Move to Workspace'),
                sensitive: hasWindow && !window.is_on_all_workspaces() && nWorkspaces > 1,
                children: workspaces,
            },
            {
                label: _('Always on Top'),
                checked: window?.is_above() ?? false,
                sensitive: hasWindow,
                activate: () => toggleAbove(window),
            },
            {separator: true},
            {
                label: _('Bring All to Front'),
                sensitive: appWindows.length > 0,
                activate: () => bringAllToFront(app, window),
            },
            {separator: true, visible: windowItems.length > 0},
            ...windowItems,
        ];
    }

    /**
     * Itens padrão do menu Ajuda (a busca entra na Fase 7, em menuBar.js).
     *
     * @returns {object[]}
     */
    buildHelpItems() {
        const {app, window, actions} = this._ctx;
        const name = app?.get_name() ?? '';

        let help = actions.node('help', {label: _('%s Help').format(name), accel: DEFAULT_ACCELS.help});
        if (!help) {
            // Sem GAction: se o app tem manual instalado (/usr/share/help),
            // abrimos no Yelp pela URI "help:<nome>".
            const helpId = this._ctx.helpId ?? null;
            help = helpId ? {
                label: _('%s Help').format(name),
                accel: DEFAULT_ACCELS.help,
                activate: () => openDocument(`help:${helpId}`),
            } : this._cmd('help', _('%s Help').format(name));
        }

        const shortcuts = actions.node('shortcuts', {
            label: _('Keyboard Shortcuts'),
            accel: DEFAULT_ACCELS.shortcuts,
        }) ?? {
            label: _('Keyboard Shortcuts'),
            accel: DEFAULT_ACCELS.shortcuts,
            sensitive: Boolean(window && isGtkWindow(window)),
            activate: () => this._ctx.keyboard.send(DEFAULT_ACCELS.shortcuts),
        };

        return [{...help, visible: Boolean(app)}, shortcuts];
    }
}

/**
 * Procura (de forma assíncrona) o manual do app em /usr/share/help/C/<id>,
 * o padrão do GNOME/Yelp. A barra chama isto quando o foco muda e guarda o
 * resultado; o menu Ajuda só consulta o resultado já pronto.
 *
 * @param {Shell.App|null} app
 * @returns {Promise<string|null>} o id do manual (para a URI "help:<id>")
 */
export async function findHelpId(app) {
    if (!app)
        return null;
    const id = app.get_id().replace(/\.desktop$/, '');
    const candidates = [...new Set([
        id,
        id.split('.').pop().toLowerCase(),
        app.app_info?.get_executable()?.split('/').pop(),
    ].filter(Boolean))];
    for (const candidate of candidates) {
        try {
            await Gio.File.new_for_path(`/usr/share/help/C/${candidate}`)
                .query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW, null);
            return candidate;
        } catch {
            // não existe — tenta o próximo nome
        }
    }
    return null;
}
