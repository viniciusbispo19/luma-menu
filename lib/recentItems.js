// SPDX-License-Identifier: GPL-3.0-or-later
// "Itens Recentes": aplicativos e documentos usados recentemente.
//
// Documentos: o GTK grava cada arquivo aberto em ~/.local/share/recently-used.xbel
// (um XML). Não podemos usar o Gtk.RecentManager porque o GTK não roda dentro
// do processo do GNOME Shell; então lemos o XML nós mesmos, de forma assíncrona.
//
// Aplicativos: o xbel não diz quais apps você abriu (só quais apps abriram
// arquivos). Por isso a extensão anota os últimos apps iniciados numa chave
// do GSettings ("recent-apps").

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {debug, logError, readTextFile} from './util.js';

const MAX_APPS = 10;
const MAX_DOCUMENTS = 10;
const XBEL_PATH = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);

// Arquivo xbel vazio (é o que o GTK escreve quando você limpa o histórico).
const EMPTY_XBEL = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info"
>
</xbel>
`;

/** Acompanha os aplicativos iniciados e guarda os mais recentes. */
export class RecentApps {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('app-state-changed', (_sys, app) => {
            if (app.state === Shell.AppState.RUNNING)
                this._remember(app.get_id());
        }, this);
    }

    _remember(appId) {
        if (!appId)
            return;
        const list = this._settings.get_strv('recent-apps').filter(id => id !== appId);
        list.unshift(appId);
        this._settings.set_strv('recent-apps', list.slice(0, MAX_APPS));
    }

    /** @returns {Shell.App[]} apps que ainda existem, do mais recente ao mais antigo */
    getApps() {
        return this._settings.get_strv('recent-apps')
            .map(id => this._appSystem.lookup_app(id))
            .filter(app => app !== null);
    }

    clear() {
        this._settings.set_strv('recent-apps', []);
    }

    destroy() {
        this._appSystem.disconnectObject(this);
    }
}

/** Troca entidades XML (&amp; etc.) pelos caracteres. */
function unescapeXml(text) {
    return text
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Lê os documentos recentes.
 *
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<{uri: string, name: string, icon: Gio.Icon}[]>}
 */
export async function loadRecentDocuments(cancellable = null) {
    const xml = await readTextFile(XBEL_PATH, cancellable);
    if (!xml)
        return [];

    const entries = [];
    for (const match of xml.matchAll(/<bookmark\s([^>]*)>([\s\S]*?)<\/bookmark>/g)) {
        const attrs = Object.fromEntries(
            [...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        if (!attrs.href)
            continue;
        const mime = match[2].match(/<mime:mime-type\s+type="([^"]+)"/)?.[1] ?? null;
        entries.push({
            uri: unescapeXml(attrs.href),
            time: Date.parse(attrs.modified ?? attrs.visited ?? attrs.added ?? '') || 0,
            mime,
        });
    }
    entries.sort((a, b) => b.time - a.time);

    // Confere (em paralelo) se os arquivos locais ainda existem.
    const candidates = entries.slice(0, MAX_DOCUMENTS * 3);
    const checks = await Promise.all(candidates.map(async entry => {
        const file = Gio.File.new_for_uri(entry.uri);
        if (!file.is_native())
            return true;
        try {
            await file.query_info_async('standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
            return true;
        } catch {
            return false;
        }
    }));

    return candidates
        .filter((_entry, i) => checks[i])
        .slice(0, MAX_DOCUMENTS)
        .map(entry => {
            const file = Gio.File.new_for_uri(entry.uri);
            const name = file.is_native()
                ? GLib.filename_display_basename(file.get_path())
                : (() => {
                    const last = entry.uri.split('/').filter(Boolean).pop() ?? entry.uri;
                    return GLib.uri_unescape_string(last, null) ?? last;
                })();
            const contentType = entry.mime
                ? Gio.content_type_from_mime_type(entry.mime) ?? entry.mime
                : null;
            const icon = contentType
                ? Gio.content_type_get_symbolic_icon(contentType)
                : Gio.ThemedIcon.new('text-x-generic-symbolic');
            return {uri: entry.uri, name, icon};
        });
}

/**
 * Abre um documento com o app padrão do tipo de arquivo.
 *
 * @param {string} uri
 */
export function openDocument(uri) {
    const context = global.create_app_launch_context(0, -1);
    Gio.AppInfo.launch_default_for_uri_async(uri, context, null, (_src, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            logError(e, `abrindo ${uri}`);
        }
    });
}

/**
 * Limpa o histórico de documentos (igual a Configurações › Privacidade ›
 * Histórico de Arquivos › Limpar Histórico). Os apps GTK abertos percebem a
 * mudança no arquivo e atualizam sozinhos.
 */
export async function clearRecentDocuments() {
    try {
        const file = Gio.File.new_for_path(XBEL_PATH);
        await file.replace_contents_async(new TextEncoder().encode(EMPTY_XBEL),
            null, false, Gio.FileCreateFlags.PRIVATE, null);
        debug('histórico de documentos limpo');
    } catch (e) {
        logError(e, 'limpando documentos recentes');
    }
}

/**
 * O usuário pode desligar o histórico em Configurações › Privacidade.
 *
 * @returns {boolean}
 */
export function isRecentHistoryEnabled() {
    const privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
    return privacy.get_boolean('remember-recent-files');
}
