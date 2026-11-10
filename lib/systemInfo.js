// SPDX-License-Identifier: GPL-3.0-or-later
// Coleta as informações do "Sobre Este Computador" — tudo de forma
// assíncrona, para não travar o Shell enquanto lê arquivos e D-Bus.
//
// Fontes (todas sem precisar rodar programas externos):
//  - /etc/os-release ............ nome e versão da distro, nome do ícone (LOGO)
//  - systemd-hostnamed (D-Bus) .. fabricante e modelo (já corrige quirks de
//                                 fabricantes como a Lenovo) e versão do kernel
//  - /proc/cpuinfo .............. processador e número de threads
//  - /proc/meminfo .............. memória total
//  - switcheroo-control (D-Bus) . nome da(s) placa(s) de vídeo
//  - Gio (filesystem info) ...... tamanho e espaço livre do disco "/"
//  - misc/config.js do Shell .... versão do GNOME

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {getDBusProperty, parseKeyValueFile, readTextFile} from './util.js';

const HOSTNAME = ['org.freedesktop.hostname1', '/org/freedesktop/hostname1', 'org.freedesktop.hostname1'];
const SWITCHEROO = ['net.hadess.SwitcherooControl', '/net/hadess/SwitcherooControl', 'net.hadess.SwitcherooControl'];

/**
 * Lê o /etc/os-release (com fallback para /usr/lib/os-release).
 *
 * @returns {Promise<Object<string, string>>}
 */
export async function getOsRelease() {
    const text = await readTextFile('/etc/os-release') ??
        await readTextFile('/usr/lib/os-release');
    return parseKeyValueFile(text);
}

async function getHostnameProperty(name) {
    return getDBusProperty(Gio.BusType.SYSTEM, ...HOSTNAME, name);
}

async function getModel() {
    const [vendor, model] = await Promise.all([
        getHostnameProperty('HardwareVendor'),
        getHostnameProperty('HardwareModel'),
    ]);
    if (vendor || model)
        return [vendor, model].filter(Boolean).join(' ');

    // Fallback: leitura direta do DMI.
    const dmi = '/sys/devices/virtual/dmi/id';
    const [v, p] = await Promise.all([
        readTextFile(`${dmi}/sys_vendor`),
        readTextFile(`${dmi}/product_name`),
    ]);
    return [v, p].map(s => s?.trim()).filter(Boolean).join(' ') || null;
}

async function getProcessor() {
    const text = await readTextFile('/proc/cpuinfo');
    if (!text)
        return null;
    const model = text.match(/^model name\s*:\s*(.+)$/m)?.[1] ??
        text.match(/^Hardware\s*:\s*(.+)$/m)?.[1] ?? null;
    const threads = (text.match(/^processor\s*:/gm) ?? []).length;
    if (!model)
        return null;
    // Remove (R) e (TM), como faz o GNOME Configurações.
    const clean = model.replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
    return threads > 1 ? `${clean} × ${threads}` : clean;
}

async function getMemory() {
    const text = await readTextFile('/proc/meminfo');
    const kb = Number(text?.match(/^MemTotal:\s*(\d+)\s*kB/m)?.[1]);
    if (!kb)
        return null;
    // IEC_UNITS = potências de 1024 (GiB), como o GNOME Configurações.
    return GLib.format_size_full(kb * 1024, GLib.FormatSizeFlags.IEC_UNITS);
}

/**
 * Encurta o nome que vem do banco de dados PCI, como o GNOME Configurações:
 *   "Intel Corporation Alder Lake-P GT2 [Iris Xe Graphics]" → "Intel Iris Xe Graphics"
 *   "NVIDIA Corporation GA107M [GeForce RTX 3050 Mobile]"  → "NVIDIA GeForce RTX 3050 Mobile"
 *
 * @param {string} name
 * @returns {string}
 */
export function prettifyGpuName(name) {
    const marketing = name.match(/\[([^\]]+)\]\s*$/)?.[1];
    if (!marketing)
        return name;
    let vendor = '';
    if (/intel/i.test(name))
        vendor = 'Intel';
    else if (/nvidia/i.test(name))
        vendor = 'NVIDIA';
    else if (/amd|ati|advanced micro/i.test(name))
        vendor = 'AMD';
    // Não repete o fabricante se ele já estiver no nome comercial.
    if (!vendor || marketing.toLowerCase().startsWith(vendor.toLowerCase()))
        return marketing;
    return `${vendor} ${marketing}`;
}

async function getGraphics() {
    const gpus = await getDBusProperty(Gio.BusType.SYSTEM, ...SWITCHEROO, 'GPUs');
    if (Array.isArray(gpus) && gpus.length) {
        return gpus.map(g => g.Name)
            .filter(Boolean)
            .map(prettifyGpuName)
            .join(' / ');
    }
    return null;
}

async function getDisk() {
    try {
        const info = await Gio.File.new_for_path('/').query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        return {size: GLib.format_size(size), free: GLib.format_size(free)};
    } catch {
        return null;
    }
}

/**
 * Junta tudo.
 *
 * @returns {Promise<object>}
 */
export async function getSystemInfo() {
    const [os, model, processor, memory, graphics, disk, kernel] = await Promise.all([
        getOsRelease(),
        getModel(),
        getProcessor(),
        getMemory(),
        getGraphics(),
        getDisk(),
        getHostnameProperty('KernelRelease')
            .then(k => k ?? readTextFile('/proc/sys/kernel/osrelease'))
            .then(k => k?.trim() ?? null),
    ]);
    return {
        osName: os.NAME ?? 'Linux',
        osVersion: os.VERSION ?? os.VERSION_ID ?? '',
        osLogo: os.LOGO ?? null,
        osId: os.ID ?? null,
        model,
        processor,
        memory,
        graphics,
        disk,
        gnomeVersion: Config.PACKAGE_VERSION,
        kernel,
    };
}
