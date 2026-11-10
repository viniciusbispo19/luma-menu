#!/usr/bin/env bash
# Tira um print da tela do Shell aninhado (precisa do dev-nested.sh rodando).
#
# Uso:
#   ./scripts/nested-screenshot.sh [arquivo.png]
# Padrão: ~/.local/state/luma-menu/nested-screenshot.png

set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/luma-menu"
BUS_FILE="$STATE_DIR/nested-bus"
OUT="$(realpath -m "${1:-$STATE_DIR/nested-screenshot.png}")"
[ -s "$BUS_FILE" ] || { echo "Sessão aninhada não está rodando (rode scripts/dev-nested.sh)." >&2; exit 1; }

# Assinatura: Screenshot(incluir_cursor, piscar_tela, arquivo) → (sucesso, arquivo)
DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")" gdbus call --session \
    --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT"
