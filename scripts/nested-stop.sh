#!/usr/bin/env bash
# Encerra o Shell aninhado aberto pelo dev-nested.sh.
#
# Cuidado com `pkill -f 'gnome-shell --devkit'`: o padrão também casa com a
# linha de comando do próprio shell que roda o pkill, que acaba se matando.
# Aqui procuramos só processos chamados exatamente "gnome-shell" que tenham
# --devkit nos argumentos — nunca o Shell da sua sessão (--mode=user).

for pid in $(pgrep -x gnome-shell); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- '--devkit'; then
        kill "$pid" && echo "Shell aninhado encerrado (PID $pid)."
    fi
done
