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
    // Relógio do Luma (painel do Isle): quantos existem, se o relógio do GNOME está visível, se o
    // calendário dele está em casa e se o Super+V voltou ao original.
    ilhas: Main.panel._rightBox.get_children().filter(c => c.get_first_child()?.constructor.name === 'LumaMenuIslandClock').length,
    relogioVisivel: Main.panel.statusArea.dateMenu.container.visible,
    calendarioEmCasa: !Main.panel.statusArea.dateMenu._calendar.get_parent()?.has_style_class_name?.('luma-island-calendar-month'),
    superVOriginal: !Object.prototype.hasOwnProperty.call(Main.panel, 'toggleCalendar') ||
      Main.panel.toggleCalendar === Object.getPrototypeOf(Main.panel).toggleCalendar,
  });
  // Conta, no palco inteiro, os atores ESTRUTURAIS das nossas classes
  // (barra, títulos, raízes de menu, diálogos — GTypes LumaMenu*). Itens de
  // menu ficam de fora: eles são criados sob demanda quando um menu abre.
  // Se algum ator estrutural sobrar após os ciclos, é vazamento nosso.
  function countOurs(actor) {
    const name = actor.constructor.name;
    let n = name.startsWith('LumaMenu') && !name.endsWith('Item') ? 1 : 0;
    for (const child of actor.get_children())
      n += countOurs(child);
    return n;
  }
  await wait(2000); // deixa as outras extensões terminarem de iniciar
  // Ciclo de aquecimento: reativar recria o Registrar, e apps Qt/Electron já
  // abertos não se registram de novo (a barra passa a usar os menus padrão).
  // Medimos a partir daqui, para comparar só o que é vazamento.
  m.disableExtension(uuid); await wait(250);
  m.enableExtension(uuid); await wait(500);
  const antes = snap();
  for (let i = 0; i < ${CYCLES}; i++) {
    m.disableExtension(uuid); await wait(250);
    m.enableExtension(uuid); await wait(250);
    // Abre o painel (pelo Super+V) e desativa com ele aberto: o calendário
    // emprestado precisa voltar para o relógio do GNOME.
    if (i % 2 === 0) { Main.panel.toggleCalendar(); await wait(150); }
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
    "bloquear remove a barra (só o Registrar fica)": data["bloqueada"]["barras"] == 0
        and data["bloqueada"]["atoresLumaNoPalco"] == 0,
    "desbloquear recria 1 barra": data["desbloqueada"]["barras"] == 1,
    "exatamente 1 relógio do Luma após os ciclos": d["ilhas"] == 1,
    "relógio do Luma esconde o do GNOME": not d["relogioVisivel"],
    "desativar remove o relógio do Luma": data["desativada"]["ilhas"] == 0,
    "desativar mostra o relógio do GNOME": data["desativada"]["relogioVisivel"],
    "desativar devolve o calendário ao relógio": data["desativada"]["calendarioEmCasa"],
    "desativar restaura o Super+V": data["desativada"]["superVOriginal"],
    "bloquear remove o relógio do Luma": data["bloqueada"]["ilhas"] == 0,
    "desbloquear recria 1 relógio do Luma": data["desbloqueada"]["ilhas"] == 1,
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
