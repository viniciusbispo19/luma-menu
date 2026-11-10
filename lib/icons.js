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
    fedora: {name: 'Fedora', color: false, osIds: ['fedora']},
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
        const ids = [osRelease.ID, ...(osRelease.ID_LIKE ?? '').split(/\s+/)]
            .filter(Boolean);
        id = Object.keys(SYSTEM_ICONS).find(key =>
            ids.some(osId => SYSTEM_ICONS[key].osIds.includes(osId))) ?? null;

        // "Automático" + "Colorido": usa o logo oficial instalado pela distro
        // (LOGO= no os-release, ex.: fedora-logo-icon), se houver.
        if (style === 'color' && osRelease.LOGO) {
            return Gio.ThemedIcon.new_from_names([osRelease.LOGO, 'distributor-logo',
                id ? `${id}-symbolic` : 'tux-symbolic']);
        }
        id ??= SYSTEM_ICONS.tux ? 'tux' : 'fedora';
    }

    if (!SYSTEM_ICONS[id])
        id = 'fedora';
    const useColor = style === 'color' && SYSTEM_ICONS[id].color;
    const file = iconsDir.get_child(useColor ? `${id}.svg` : `${id}-symbolic.svg`);
    return new Gio.FileIcon({file});
}
