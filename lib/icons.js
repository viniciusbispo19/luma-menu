// SPDX-License-Identifier: GPL-3.0-or-later
// Ícones do sistema (o "logo" no lugar da maçã).
//
// Cada logo tem até dois arquivos em icons/:
//   <id>-symbolic.svg  monocromático, recolorido pelo tema (padrão)
//   <id>.svg           colorido (opção "Colorido")
// As origens e licenças estão em icons/CREDITS.md.

import Gio from 'gi://Gio';

/**
 * Logos embutidos. `color: false` = só existe a versão simbólica.
 * `osIds` = valores de ID/ID_LIKE do /etc/os-release que usam este logo.
 */
export const SYSTEM_ICONS = {
    fedora: {name: 'Fedora', color: true, osIds: ['fedora']},
    tux: {name: 'Tux (Linux)', color: true, osIds: []},
    gnome: {name: 'GNOME', color: true, osIds: []},
    ubuntu: {name: 'Ubuntu', color: true, osIds: ['ubuntu']},
    debian: {name: 'Debian', color: true, osIds: ['debian']},
    arch: {name: 'Arch Linux', color: true, osIds: ['arch', 'archlinux']},
    opensuse: {name: 'openSUSE', color: true,
        osIds: ['opensuse', 'opensuse-tumbleweed', 'opensuse-leap', 'suse']},
    mint: {name: 'Linux Mint', color: true, osIds: ['linuxmint']},
    popos: {name: 'Pop!_OS', color: true, osIds: ['pop']},
    manjaro: {name: 'Manjaro', color: true, osIds: ['manjaro', 'manjaro-arm']},
    nixos: {name: 'NixOS', color: true, osIds: ['nixos']},
    zorin: {name: 'Zorin OS', color: true, osIds: ['zorin']},
    elementary: {name: 'elementary OS', color: true, osIds: ['elementary']},
};

/**
 * Descobre qual ícone usar.
 *
 * @param {object} params
 * @param {string} params.choice - chave "system-icon" (ex.: 'fedora', 'auto', 'custom')
 * @param {string} params.style - 'symbolic' ou 'color'
 * @param {string} params.customPath - arquivo escolhido pelo usuário
 * @param {object} params.osRelease - conteúdo do /etc/os-release (pode ser {})
 * @param {Gio.File} params.iconsDir - pasta icons/ da extensão
 * @returns {Gio.Icon}
 */
export function resolveSystemIcon({choice, style, customPath, osRelease, iconsDir}) {
    if (choice === 'custom' && customPath)
        return new Gio.FileIcon({file: Gio.File.new_for_path(customPath)});

    let id = choice;
    if (choice === 'auto') {
        // O ID da própria distro vem primeiro; ID_LIKE (a "família") depois.
        // Ex.: Linux Mint tem ID=linuxmint e ID_LIKE="ubuntu debian".
        const ids = [osRelease.ID, ...(osRelease.ID_LIKE ?? '').split(/\s+/)]
            .filter(Boolean);
        id = null;
        for (const osId of ids) {
            id = Object.keys(SYSTEM_ICONS).find(key => SYSTEM_ICONS[key].osIds.includes(osId)) ?? null;
            if (id)
                break;
        }

        // "Automático" + "Colorido": usa o logo oficial instalado pela distro
        // (LOGO= no os-release, ex.: fedora-logo-icon), se houver.
        if (style === 'color' && osRelease.LOGO) {
            return Gio.ThemedIcon.new_from_names([osRelease.LOGO, 'distributor-logo',
                id ? `${id}-symbolic` : 'tux-symbolic']);
        }
        id ??= 'tux'; // distro desconhecida: o pinguim
    }

    if (!SYSTEM_ICONS[id])
        id = 'fedora';
    const useColor = style === 'color' && SYSTEM_ICONS[id].color;
    const file = iconsDir.get_child(useColor ? `${id}.svg` : `${id}-symbolic.svg`);
    return new Gio.FileIcon({file});
}
