#!/usr/bin/env bash
# Empacota e instala a extensão em ~/.local/share/gnome-shell/extensions/.
#
# Por que não usar um link simbólico para a pasta do projeto? Porque um
# `gnome-extensions install --force` posterior apagaria o destino do link —
# ou seja, o seu código-fonte. Copiar via pacote é mais seguro e testa
# exatamente o que será publicado.
#
# No Wayland o Shell em execução NÃO recarrega o código de uma extensão.
# Depois de instalar, teste numa sessão aninhada (scripts/dev-nested.sh),
# que é um Shell novo e lê os arquivos atualizados.

set -euo pipefail
cd "$(dirname "$0")/.."

UUID=luma-menu@viniciusbispo19

./scripts/build.sh
gnome-extensions install --force "build/$UUID.shell-extension.zip"
echo "Instalado em ~/.local/share/gnome-shell/extensions/$UUID"
