// SPDX-License-Identifier: GPL-3.0-or-later
// Menu do aplicativo (o título em negrito, ex.: "Editor de Texto").
//
// Cada item tenta, em ordem: a GAction do app (camada C), um item equivalente
// achado nos menus reais do app (camadas A/B, quando existirem) e, por fim,
// uma alternativa genérica. Se nada garante o efeito, o item fica cinza.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    canHideOthers, canShowAll, getAppWindows, hideApp, hideOthers, lookupApp,
    showAll, showAppDetails,
} from './actions.js';

/**
 * @param {object} ctx
 * @param {Shell.App|null} ctx.app
 * @param {boolean} ctx.isDesktop - nenhuma janela em foco (mostrando Arquivos)
 * @param {AppActions} ctx.actions - camada C
 * @param {object} [ctx.merged] - itens achados nos menus reais do app:
 *   {about, preferences, quit} (nós de menu prontos), vindos das camadas A/B
 * @returns {object[]} nós do menu
 */
export function buildAppMenu({app, isDesktop, actions, merged = {}}) {
    if (!app)
        return [{label: _('No application'), sensitive: false}];

    const name = app.get_name();
    const hasWindows = getAppWindows(app).some(w => !w.minimized);

    // "Sobre": GAction do app → item real do app → página na Central de Programas.
    const about = actions.node('about', {label: _('About %s').format(name)}) ??
        (merged.about ? {...merged.about, label: _('About %s').format(name)} : null) ?? {
        label: _('About %s').format(name),
        // Sem "Sobre" próprio: mostra a página do app na Central de Programas
        // (cinza se o GNOME Software não estiver instalado).
        sensitive: lookupApp('org.gnome.Software.desktop') !== null,
        activate: () => showAppDetails(app),
    };

    // "Configurações…": só quando o app realmente oferece preferências.
    const preferences = actions.node('preferences', {
        label: _('Settings…'),
        accel: '<Control>comma',
    }) ?? (merged.preferences
        ? {...merged.preferences, label: _('Settings…'), accel: merged.preferences.accel || '<Control>comma'}
        : {label: _('Settings…'), accel: '<Control>comma', sensitive: false});

    // "Sair": GAction app.quit → item real → pedir ao Shell para fechar o app
    // (Shell.App.request_quit fecha as janelas educadamente; o app pode
    // perguntar se você quer salvar).
    const quit = actions.node('quit', {label: _('Quit %s').format(name), accel: '<Control>q'}) ??
        (merged.quit ? {...merged.quit, label: _('Quit %s').format(name), accel: '<Control>q'} : null) ?? {
        label: _('Quit %s').format(name),
        accel: '<Control>q',
        activate: () => app.request_quit(),
    };

    return [
        about,
        {separator: true},
        preferences,
        {separator: true},
        {
            label: _('Hide %s').format(name),
            accel: '<Super>h',
            sensitive: hasWindows && !isDesktop,
            activate: () => hideApp(app),
        },
        {
            label: _('Hide Others'),
            sensitive: canHideOthers(isDesktop ? null : app),
            activate: () => hideOthers(isDesktop ? null : app),
        },
        {
            label: _('Show All'),
            sensitive: canShowAll(),
            activate: () => showAll(),
        },
        // Como o Finder do macOS, o Arquivos na área de trabalho não tem "Sair".
        {separator: true, visible: !isDesktop},
        {...quit, visible: !isDesktop},
    ];
}
