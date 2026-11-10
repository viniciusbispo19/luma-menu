#!/usr/bin/env bash
# Testes de robustez no Shell aninhado (precisa do dev-nested.sh rodando).
#
# Critérios de aceite verificados:
#   - ativar/desativar N vezes (padrão 10) sem erro e sem duplicar a barra;
#   - desativar restaura o painel (barra some, botão Atividades volta);
#   - bloquear/desbloquear (simulado com o mesmo mecanismo da tela de
#     bloqueio: Main.sessionMode.pushMode('unlock-dialog')) não duplica nada;
#   - nenhuma linha nova de erro no log mencionando a extensão.
#
# Uso: ./scripts/nested-test.sh [ciclos]

set -euo pipefail
cd "$(dirname "$0")/.."

CYCLES="${1:-10}"
LOG=$(ls -t "${XDG_STATE_HOME:-$HOME/.local/state}"/luma-menu/nested-*.log | head -1)
BEFORE=$(wc -l < "$LOG")

./scripts/nested-eval.sh "(async () => {
  const uuid = 'luma-menu@viniciusbispo19', m = Main.extensionManager;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => ({
    estado: m.lookup(uuid).state,
    erro: m.lookup(uuid).error || null,
    barras: Main.panel._leftBox.get_children().filter(c => c.name === 'lumaMenuBar').length,
    atividadesVisivel: Main.panel.statusArea.activities.container.visible,
    menusNoGerenciador: Main.panel.menuManager._menus.length,
    atoresNoUiGroup: Main.layoutManager.uiGroup.get_n_children(),
    atoresLumaNoPalco: countOurs(global.stage),
  });
  // Conta, no palco inteiro, os atores criados pelas NOSSAS classes
  // (GTypes LumaMenu*). Se algum sobrar após os ciclos, é vazamento nosso.
  function countOurs(actor) {
    let n = actor.constructor.name.startsWith('LumaMenu') ? 1 : 0;
    for (const child of actor.get_children())
      n += countOurs(child);
    return n;
  }
  await wait(2000); // deixa as outras extensões terminarem de iniciar
  const antes = snap();
  for (let i = 0; i < ${CYCLES}; i++) {
    m.disableExtension(uuid); await wait(250);
    m.enableExtension(uuid); await wait(250);
  }
  const depois = snap();
  m.disableExtension(uuid); await wait(300);
  const desativada = snap();
  m.enableExtension(uuid); await wait(300);
  Main.sessionMode.pushMode('unlock-dialog'); await wait(500);
  const bloqueada = snap();
  Main.sessionMode.popMode('unlock-dialog'); await wait(800);
  const desbloqueada = snap();
  return {antes, depois, desativada, bloqueada, desbloqueada};
})()" | sed "s/^(true, '//; s/')\$//" | python3 -I -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("Falha no Eval:", raw); sys.exit(1)
print(json.dumps(data, indent=1, ensure_ascii=False))
a, d = data["antes"], data["depois"]
checks = {
    "ativa e sem erro após os ciclos": d["estado"] == 1 and not d["erro"],
    "exatamente 1 barra após os ciclos": d["barras"] == 1,
    "nenhum menu sobrando no gerenciador": d["menusNoGerenciador"] == a["menusNoGerenciador"],
    "nenhum ator nosso sobrando no palco": d["atoresLumaNoPalco"] == a["atoresLumaNoPalco"],
    "desativar remove todos os atores nossos": data["desativada"]["atoresLumaNoPalco"] == 0,
    "desativar remove a barra": data["desativada"]["barras"] == 0,
    "desativar mostra o botão Atividades": data["desativada"]["atividadesVisivel"],
    "desbloquear recria 1 barra": data["desbloqueada"]["barras"] == 1,
}
for name, ok in checks.items():
    print(("  ✓ " if ok else "  ✗ ") + name)
print("RESULTADO:", "OK" if all(checks.values()) else "FALHOU")
'

echo "--- avisos novos no log causados pelo Luma Menu:"
tail -n +$((BEFORE + 1)) "$LOG" | python3 -I -c '
import re, sys
blocks, cur = [], []
for line in sys.stdin.read().splitlines():
    if re.search(r"(CRITICAL|WARNING|ERROR) \*\*", line):
        if cur: blocks.append(cur)
        cur = [line]
    elif cur and line.strip():
        cur.append(line)
    elif cur:
        blocks.append(cur); cur = []
if cur: blocks.append(cur)
ours = [b for b in blocks if any("luma-menu@" in l for l in b)]
other = [b for b in blocks if not any("@file://" in l or "@resource://" in l for l in b[1:])]
for b in ours:
    print("\n".join(b)); print()
if not ours:
    print("(nenhum)")
print(f"(outros avisos novos: {len(blocks) - len(ours)}, dos quais {len(other)} sem pilha JS)")
'
