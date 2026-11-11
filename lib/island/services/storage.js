// SPDX-License-Identifier: GPL-3.0-or-later
// Arquivos JSON em ~/.local/share/luma-menu/, lidos e gravados de forma
// ASSÍNCRONA (o Shell nunca trava esperando o disco).
//
// A gravação é atômica: o Gio escreve num arquivo temporário e só então o
// renomeia por cima do antigo (replace_contents faz isso). Se a energia cair
// no meio, sobra o arquivo antigo inteiro — nunca um arquivo pela metade.
// Um arquivo corrompido não é apagado: é guardado ao lado (".corrompido").

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {logError} from '../../util.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
// Atenção: o Gio NÃO tem make_directory_with_parents_async (só a versão
// síncrona); por isso ensureDirectory() abaixo cria pasta por pasta.
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'move_async');

/** ~/.local/share/luma-menu/<nome> */
export function dataFile(name) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'luma-menu', name]));
}

/**
 * @param {Gio.File} file
 * @param {*} fallback - valor se o arquivo não existir ou estiver ruim
 * @returns {Promise<*>}
 */
export async function loadJson(file, fallback) {
    let text;
    try {
        const [bytes] = await file.load_contents_async(null);
        text = new TextDecoder().decode(bytes);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            logError(e, `lendo ${file.get_path()}`);
        return fallback;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        // Corrompido: guarda ao lado em vez de perder em silêncio.
        logError(e, `${file.get_path()} corrompido; guardado como .corrompido`);
        const aside = Gio.File.new_for_path(`${file.get_path()}.corrompido`);
        file.move_async(aside, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null)
            .catch(err => logError(err, 'guardando arquivo corrompido'));
        return fallback;
    }
}

/**
 * Cria a pasta (e as de cima que faltarem), sem travar o Shell.
 *
 * @param {Gio.File} dir
 */
async function ensureDirectory(dir) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await ensureDirectory(dir.get_parent());
        await ensureDirectory(dir);
    }
}

/**
 * @param {Gio.File} file
 * @param {*} data
 */
export async function saveJson(file, data) {
    await ensureDirectory(file.get_parent());
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 1));
    // make_backup = false; flags REPLACE_DESTINATION: escreve num temporário e
    // renomeia (atômico).
    await file.replace_contents_async(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
}
