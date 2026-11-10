#!/usr/bin/env bash
# Extrai as strings traduzíveis do código e atualiza as traduções.
#
#   1. xgettext varre os .js procurando _('...') e gera po/luma-menu.pot
#      (o "modelo" com todas as strings em inglês, sem tradução);
#   2. msgmerge atualiza cada po/*.po com as strings novas/alteradas,
#      sem perder o que já foi traduzido.
#
# Depois de rodar, abra po/pt_BR.po e preencha os msgstr "" vazios.
# A compilação (.po → .mo) acontece no build (scripts/build.sh).

set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN=luma-menu
VERSION=$(python3 -I -c 'import json; print(json.load(open("metadata.json"))["version-name"])')

# Todos os .js da extensão (fora ferramentas de desenvolvimento).
mapfile -t SOURCES < <(find . -name '*.js' \
    -not -path './node_modules/*' -not -path './build/*' -not -path './dev/*' \
    -not -name 'eslint.config.js' -printf '%P\n' | sort)
# (-printf '%P\n' tira o "./" do início dos caminhos, que aparecem no .pot.)
# Aviso conhecido: o xgettext 1.0 consulta o git para datar o .pot e às vezes
# imprime "vc-mtime: git ls-files returned an unexpected file name". É inofensivo:
# afeta só o campo POT-Creation-Date, não as traduções.

xgettext \
    --from-code=UTF-8 \
    --language=JavaScript \
    --keyword=_ --keyword=N_ \
    --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --add-comments=Translators \
    --package-name="Luma Menu" \
    --package-version="$VERSION" \
    --msgid-bugs-address="https://github.com/viniciusbispo19/luma-menu/issues" \
    --output="po/$DOMAIN.pot" \
    "${SOURCES[@]}"

for po in po/*.po; do
    [ -e "$po" ] || continue
    msgmerge --quiet --update --backup=none "$po" "po/$DOMAIN.pot"
    echo "Atualizado: $po"
    msgfmt --check --statistics -o /dev/null "$po"
done
