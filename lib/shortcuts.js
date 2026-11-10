// SPDX-License-Identifier: GPL-3.0-or-later
// Converte atalhos do formato GTK/GSettings ("<Control><Shift>z") para texto
// legível: "Ctrl+Shift+Z" (estilo texto) ou "⌃⇧Z" (estilo símbolos do Mac).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Ordem de exibição. No macOS a ordem oficial é ⌃ ⌥ ⇧ ⌘; usamos a mesma
// ordem no texto (Ctrl, Alt, Shift, Super) para os dois estilos baterem.
const MODIFIERS = [
    {names: ['control', 'ctrl', 'primary'], text: 'Ctrl', symbol: '⌃'},
    {names: ['alt', 'mod1'], text: 'Alt', symbol: '⌥'},
    {names: ['shift'], text: 'Shift', symbol: '⇧'},
    {names: ['super', 'meta', 'hyper', 'mod4'], text: 'Super', symbol: '❖'},
];

// Nomes de teclas (keysyms do X11/GDK) → como mostrar.
const KEY_NAMES = {
    Delete: {text: 'Del', symbol: '⌦'},
    BackSpace: {text: 'Backspace', symbol: '⌫'},
    Escape: {text: 'Esc', symbol: '⎋'},
    Return: {text: 'Enter', symbol: '↩'},
    KP_Enter: {text: 'Enter', symbol: '⌤'},
    Tab: {text: 'Tab', symbol: '⇥'},
    Left: {text: '←', symbol: '←'},
    Right: {text: '→', symbol: '→'},
    Up: {text: '↑', symbol: '↑'},
    Down: {text: '↓', symbol: '↓'},
    Page_Up: {text: 'PgUp', symbol: '⇞'},
    Page_Down: {text: 'PgDn', symbol: '⇟'},
    Home: {text: 'Home', symbol: '↖'},
    End: {text: 'End', symbol: '↘'},
    comma: {text: ',', symbol: ','},
    period: {text: '.', symbol: '.'},
    plus: {text: '+', symbol: '+'},
    KP_Add: {text: '+', symbol: '+'},
    minus: {text: '-', symbol: '-'},
    KP_Subtract: {text: '-', symbol: '-'},
    equal: {text: '=', symbol: '='},
    question: {text: '?', symbol: '?'},
    slash: {text: '/', symbol: '/'},
    backslash: {text: '\\', symbol: '\\'},
    semicolon: {text: ';', symbol: ';'},
    apostrophe: {text: "'", symbol: "'"},
    bracketleft: {text: '[', symbol: '['},
    bracketright: {text: ']', symbol: ']'},
    grave: {text: '`', symbol: '`'},
};

export const ShortcutStyle = {
    TEXT: 'text',
    SYMBOLS: 'symbols',
};

/**
 * @param {string} accel - ex.: "<Control><Shift>z", "<Super>l", "F11"
 * @param {string} [style] - ShortcutStyle.TEXT (padrão) ou SYMBOLS
 * @returns {string} ex.: "Ctrl+Shift+Z" ou "⌃⇧Z"; "" se vazio/inválido
 */
export function formatAccelerator(accel, style = ShortcutStyle.TEXT) {
    if (!accel)
        return '';

    const mods = new Set();
    const key = accel.replace(/<([^>]+)>/g, (_match, mod) => {
        mods.add(mod.toLowerCase());
        return '';
    }).trim();
    if (!key)
        return '';

    const symbols = style === ShortcutStyle.SYMBOLS;
    const parts = MODIFIERS
        .filter(m => m.names.some(n => mods.has(n)))
        .map(m => (symbols ? m.symbol : m.text));

    let keyLabel;
    if (KEY_NAMES[key])
        keyLabel = symbols ? KEY_NAMES[key].symbol : KEY_NAMES[key].text;
    else if (key === 'space')
        keyLabel = symbols ? '␣' : _('Space');
    else if (key.length === 1)
        keyLabel = key.toUpperCase();
    else
        keyLabel = key.replace(/^KP_/, '');

    parts.push(keyLabel);
    // Estilo Mac junta tudo ("⌃⇧Z"); estilo texto separa com "+".
    return symbols ? parts.join('') : parts.join('+');
}

/**
 * Converte o formato de atalho do DBusMenu ([["Control", "c"]]) para o do GTK.
 *
 * @param {string[][]} shortcut
 * @returns {string} ex.: "<Control>c"
 */
export function dbusMenuShortcutToAccel(shortcut) {
    const first = shortcut?.[0];
    if (!first?.length)
        return '';
    const key = first[first.length - 1];
    const mods = first.slice(0, -1).map(m => `<${m}>`).join('');
    return `${mods}${key}`;
}
