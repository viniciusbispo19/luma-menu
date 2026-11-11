#!/usr/bin/env bash
# Gera o pacote .zip da extensão em build/ usando a ferramenta OFICIAL
# (`gnome-extensions pack`) — o mesmo formato aceito pelo extensions.gnome.org.
#
# O pack inclui sozinho: metadata.json, extension.js, prefs.js e stylesheet.css.
# Todo o resto precisa ser listado com --extra-source.
# Com --podir ele também compila po/*.po em locale/<idioma>/LC_MESSAGES/*.mo.

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build

ARGS=(
    --force
    --out-dir=build
    --podir=po
    --gettext-domain=luma-menu
    --extra-source=lib
    --extra-source=icons
    --extra-source=tray
    --extra-source=LICENSE
)

# O schema de configurações só existirá a partir da fase em que criarmos opções.
SCHEMA=schemas/org.gnome.shell.extensions.luma-menu.gschema.xml
[ -f "$SCHEMA" ] && ARGS+=(--schema="$SCHEMA")

gnome-extensions pack "${ARGS[@]}" .
echo "Pacote: build/luma-menu@viniciusbispo19.shell-extension.zip"
