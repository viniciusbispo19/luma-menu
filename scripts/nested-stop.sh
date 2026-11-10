#!/usr/bin/env bash
# Encerra o Shell aninhado aberto pelo dev-nested.sh.
#
# Cuidado com `pkill -f 'gnome-shell --devkit'`: o padrão também casa com a
# linha de comando do próprio shell que roda o pkill, que acaba se matando.
# Aqui procuramos só processos chamados exatamente "gnome-shell" que tenham
# --devkit nos argumentos — nunca o Shell da sua sessão (--mode=user).

BUS_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/luma-menu/nested-bus"

for pid in $(pgrep -x gnome-shell); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- '--devkit'; then
        kill "$pid"
        # Espera o processo sair de verdade (até 10 s). Sem isso, um
        # dev-nested.sh iniciado logo em seguida pode ter o arquivo do
        # barramento apagado pela limpeza da sessão antiga.
        for _ in $(seq 50); do
            [ -d "/proc/$pid" ] || break
            sleep 0.2
        done
        echo "Shell aninhado encerrado (PID $pid)."
    fi
done
rm -f "$BUS_FILE"
