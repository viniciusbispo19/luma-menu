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

# 2. Cria o dconf isolado a partir das suas configurações atuais.
cp "$DCONF_DIR/user" "$DCONF_DIR/$DEV_DB"
printf 'user-db:%s\n' "$DEV_DB" > "$STATE_DIR/dconf-profile"
export DCONF_PROFILE="$STATE_DIR/dconf-profile"

# 3. No dconf isolado: ativa o Luma Menu + auxiliar e garante que a Global Menu
#    esteja desligada. (gsettings respeita o DCONF_PROFILE exportado acima.)
python3 -I - "$UUID" "$DEVTOOLS_UUID" <<'EOF'
import ast, subprocess, sys

def get_list(key):
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True, timeout=10).strip()
    return [] if out.startswith('@as') else ast.literal_eval(out)

def set_list(key, values):
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, str(values)], timeout=10)

ours = sys.argv[1:]
enabled = [u for u in get_list('enabled-extensions') if u != 'globalmenu@ShiroOSL.github.io']
set_list('enabled-extensions', enabled + [u for u in ours if u not in enabled])
set_list('disabled-extensions', [u for u in get_list('disabled-extensions') if u not in ours])
subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'disable-user-extensions', 'false'], timeout=10)
EOF

echo "Monitor virtual: $SIZE"
echo "Log desta sessão: $LOG"
echo "Feche a janela do devkit (ou Ctrl+C aqui) para encerrar."

# 4. Sobe o Shell aninhado.
# dbus-run-session: cria um barramento D-Bus novo e só desse Shell. Essencial
#   para a camada B (Registrar), que não pode colidir com a sua sessão real.
#   Salvamos o endereço desse barramento em $BUS_FILE para os scripts
#   nested-eval.sh e nested-screenshot.sh conversarem com o Shell aninhado.
# --devkit: abre o Shell dentro da janela do mutter-devkit (substitui o antigo
#   --nested, que não existe mais no GNOME 49+).
# LUMA_MENU_DEV=1: avisa a extensão auxiliar que ela pode ligar o modo inseguro.
export LUMA_MENU_DEV=1
trap 'rm -f "$BUS_FILE"' EXIT
dbus-run-session -- bash -c '
    echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
    exec gnome-shell --devkit --wayland --devkit-args="--monitor-size=$2"
' _ "$BUS_FILE" "$SIZE" 2>&1 | tee "$LOG"
