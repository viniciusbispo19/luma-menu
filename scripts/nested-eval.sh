#!/usr/bin/env bash
# Executa JavaScript DENTRO do Shell aninhado (precisa do dev-nested.sh rodando).
#
# Exemplo:
#   ./scripts/nested-eval.sh 'Main.panel._leftBox.get_first_child().name'
#
# Dentro do código estão disponíveis `Main`, `global` e os imports do Shell.
# A resposta vem como (true, '<resultado em JSON>') ou (false, '<erro>').

set -euo pipefail

BUS_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/luma-menu/nested-bus"
[ -s "$BUS_FILE" ] || { echo "Sessão aninhada não está rodando (rode scripts/dev-nested.sh)." >&2; exit 1; }

DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")" gdbus call --session \
    --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1"
