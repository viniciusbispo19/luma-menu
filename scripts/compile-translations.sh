#!/usr/bin/env bash
# Compila as traduções (po/*.po → locale/<idioma>/LC_MESSAGES/luma-menu.mo).
#
# Normalmente você NÃO precisa rodar isto: o scripts/build.sh usa
# `gnome-extensions pack --podir=po`, que já compila tudo dentro do pacote.
# Este script é útil para conferir uma tradução (msgfmt --check aponta erros
# como "%s" faltando) e ver as estatísticas.

set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN=luma-menu
for po in po/*.po; do
    lang=$(basename "$po" .po)
    mkdir -p "locale/$lang/LC_MESSAGES"
    msgfmt --check --statistics -o "locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
    echo "Compilado: locale/$lang/LC_MESSAGES/$DOMAIN.mo"
done
