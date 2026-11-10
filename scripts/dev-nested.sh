#!/usr/bin/env bash
# Abre um GNOME Shell 51 "aninhado" (dentro de uma janela) usando o mutter-devkit,
# já com o Luma Menu instalado e ativado.
#
# Por que isso existe: no Wayland não dá para reiniciar o Shell da sua sessão
# (Alt+F2 → r só funcionava no X11). Para testar mudanças na extensão sem
# fazer logout, rodamos um segundo Shell, isolado, dentro de uma janela.
#
# Uso:
#   ./scripts/dev-nested.sh            # monitor virtual 1600x1000
#   ./scripts/dev-nested.sh 1920x1200  # outro tamanho
#
# Isolamento de configurações (dconf):
#   O GNOME guarda as configurações em ~/.config/dconf/user. Se o Shell aninhado
#   usasse esse arquivo, ativar o Luma Menu lá dentro o ativaria também na sua
#   sessão real. Então copiamos o arquivo para ~/.config/dconf/luma_menu_dev e
#   apontamos o Shell aninhado para a cópia (variável DCONF_PROFILE). Resultado:
#   mesmo tema e mesmas extensões (ótimo para testar compatibilidade com Luma
#   Dock, Blur my Shell…), mas nada do que muda lá dentro vaza para cá.
#   A cópia é refeita a cada execução.

set -euo pipefail
cd "$(dirname "$0")/.."

SIZE="${1:-1600x1000}"
UUID=luma-menu@viniciusbispo19
DEVTOOLS_UUID=luma-menu-devtools@viniciusbispo19
DEV_DB=luma_menu_dev  # sem hífen: o nome vira parte de um caminho D-Bus (/ca/desrt/dconf/Writer/<nome>)

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/luma-menu"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/nested-$(date +%Y%m%d-%H%M%S).log"
BUS_FILE="$STATE_DIR/nested-bus"   # endereço do D-Bus da sessão aninhada
DCONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dconf"

# 1. Empacota e instala a versão atual do código (e a extensão auxiliar).
./scripts/install.sh
gnome-extensions pack --force --out-dir=build "dev/$DEVTOOLS_UUID" >/dev/null
gnome-extensions install --force "build/$DEVTOOLS_UUID.shell-extension.zip"

# 2. Prepara o dconf isolado e sobe o Shell aninhado.
#
# Atenção a um detalhe do dconf: cada barramento D-Bus tem o SEU dconf-service,
# que guarda o banco em memória e regrava o arquivo inteiro a cada mudança.
# Se escrevêssemos no banco isolado pelo barramento da sessão real e o Shell
# aninhado escrevesse pelo barramento dele, um sobrescreveria o outro. Por isso
# a cópia e as escritas acontecem DENTRO do barramento aninhado, antes do Shell.
printf 'user-db:%s\n' "$DEV_DB" > "$STATE_DIR/dconf-profile"
export DCONF_PROFILE="$STATE_DIR/dconf-profile"
export DCONF_DIR DEV_DB UUID DEVTOOLS_UUID
# LUMA_MENU_DEV=1: avisa a extensão auxiliar que ela pode ligar o modo inseguro.
export LUMA_MENU_DEV=1
# SHELL_DEBUG=backtrace-warnings: cada aviso/CRITICAL no log vem acompanhado
# da pilha de chamadas JavaScript — mostra QUAL código causou o problema.
export SHELL_DEBUG=backtrace-warnings

echo "Monitor virtual: $SIZE"
echo "Log desta sessão: $LOG"
echo "Feche a janela do devkit (ou Ctrl+C aqui) para encerrar."

# dbus-run-session: cria um barramento D-Bus novo e só desse Shell. Essencial
#   para a camada B (Registrar), que não pode colidir com a sua sessão real.
#   Salvamos o endereço desse barramento em $BUS_FILE para os scripts
#   nested-eval.sh e nested-screenshot.sh conversarem com o Shell aninhado.
# --devkit: abre o Shell dentro da janela do mutter-devkit (substitui o antigo
#   --nested, que não existe mais no GNOME 49+).
trap 'rm -f "$BUS_FILE"' EXIT
dbus-run-session -- bash -c '
    set -e
    cp "$DCONF_DIR/user" "$DCONF_DIR/$DEV_DB"
    python3 -I scripts/dconf-enable-extensions.py "$UUID" "$DEVTOOLS_UUID"
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
    exec gnome-shell --devkit --wayland --devkit-args="--monitor-size=$2"
' _ "$BUS_FILE" "$SIZE" 2>&1 | tee "$LOG"
