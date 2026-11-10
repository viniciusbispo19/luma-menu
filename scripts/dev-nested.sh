#!/usr/bin/env bash
# Abre um GNOME Shell 51 "aninhado" (dentro de uma janela) usando o mutter-devkit.
#
# Por que isso existe: no Wayland não dá para reiniciar o Shell da sua sessão
# (Alt+F2 → r só funcionava no X11). Para testar mudanças na extensão sem
# fazer logout, rodamos um segundo Shell, isolado, dentro de uma janela.
#
# Uso:
#   ./scripts/dev-nested.sh            # monitor virtual 1600x1000
#   ./scripts/dev-nested.sh 1920x1200  # outro tamanho
#
# Observação importante: o Shell aninhado lê as MESMAS configurações (dconf)
# da sua sessão. Ou seja: carrega suas extensões ativas (ótimo para testar
# compatibilidade com Luma Dock, Blur my Shell etc.) e qualquer extensão que
# você ativar lá dentro também ficará ativa na sua sessão no próximo login.

set -euo pipefail

SIZE="${1:-1600x1000}"

# Os logs vão para ~/.local/state/luma-menu/, fora do projeto.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/luma-menu"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/nested-$(date +%Y%m%d-%H%M%S).log"

echo "Monitor virtual: $SIZE"
echo "Log desta sessão: $LOG"
echo "Feche a janela do devkit (ou Ctrl+C aqui) para encerrar."

# dbus-run-session: cria um barramento de sessão D-Bus novo e só desse Shell.
#   Isso é essencial para a camada B (Registrar): o nome
#   com.canonical.AppMenu.Registrar registrado lá dentro não colide com a sua
#   sessão real.
# --devkit: abre o Shell dentro da janela do mutter-devkit (substitui o antigo
#   --nested, que não existe mais no GNOME 49+).
# --devkit-args: repassa opções ao mutter-devkit (aqui, o tamanho do monitor).
# tee: mostra o log na tela e salva no arquivo ao mesmo tempo.
dbus-run-session -- \
    gnome-shell --devkit --wayland --devkit-args="--monitor-size=$SIZE" \
    2>&1 | tee "$LOG"
