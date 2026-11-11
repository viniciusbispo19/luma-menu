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
    barraPreta: (Main.panel.style ?? '').includes('rgba(0, 0, 0,'),
    barraPretaPref: m.lookup(uuid).stateObj?._settings?.get_boolean('black-bar') ?? null,
    // Bateria: o ícone do GNOME volta ao desativar; o OSD volta ao original.
    bateriaGnomeVisivel: Main.panel.statusArea.quickSettings._system?.visible ?? true,
    osdOriginal: !Object.prototype.hasOwnProperty.call(Main.osdWindowManager, 'showAll') ||
      Main.osdWindowManager.showAll === Object.getPrototypeOf(Main.osdWindowManager).showAll,
    superficies: Main.layoutManager.uiGroup.get_children().filter(c => c.constructor.name === 'LumaMenuIslandSurface').length,
    superVOriginal: !Object.prototype.hasOwnProperty.call(Main.panel, 'toggleCalendar') ||
      Main.panel.toggleCalendar === Object.getPrototypeOf(Main.panel).toggleCalendar,
    // Prateleira: o atalho Super+Shift+V só existe com o relógio do Luma; a
    // bandeja de arquivos (janela GTK) fecha junto com a extensão.
    // (removeKeybinding não apaga a entrada: deixa o modo em NONE = 0.)
    atalhoPrateleira: (Main.wm._allowedKeybindings['clipboard-shortcut'] ?? 0) !== 0,
    bandejas: global.get_window_actors().filter(a => a.meta_window.get_wm_class() === 'io.github.viniciusbispo19.LumaMenu.Tray').length,
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
    // Um alerta de volume no meio do ciclo (a forma do alerta precisa sumir).
    Main.osdWindowManager.showAll(new (imports.gi.Gio.ThemedIcon)({name: 'audio-volume-medium-symbolic'}), null, 0.5, 1);
    if (i % 4 === 0) { m.lookup(uuid).stateObj._island.toggle('shelf', true); await wait(150); }
    else if (i % 2 === 0) { Main.panel.toggleCalendar(); await wait(150); }
    // E com um menu da barra aberto (a forma do Isle atrás dele).
    else {
      const bar = Main.panel._leftBox.get_children().find(c => c.name === 'lumaMenuBar');
      bar?._menuButtons[1]?.menu.open(); await wait(150);
    }
  }
  // Fecha o que ficou aberto (menu do último ciclo) antes de comparar.
  Main.panel.menuManager.activeMenu?.close(); await wait(900);
  const depois = snap();
  // Abre a bandeja de arquivos e desativa com ela aberta.
  m.lookup(uuid).stateObj._fileTray.open(); await wait(3000);
  const comBandeja = snap();
  m.disableExtension(uuid); await wait(800);
  const desativada = snap();
  m.enableExtension(uuid); await wait(300);
  Main.sessionMode.pushMode('unlock-dialog'); await wait(500);
  const bloqueada = snap();
  Main.sessionMode.popMode('unlock-dialog'); await wait(800);
  const desbloqueada = snap();
  return {antes, depois, comBandeja, desativada, bloqueada, desbloqueada};
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
    "barra preta conforme a preferência": d["barraPreta"] == bool(d["barraPretaPref"]),
    "desativar devolve a cor original da barra": not data["desativada"]["barraPreta"],
    "desativar remove as formas do Isle": data["desativada"]["superficies"] == 0,
    "desativar mostra o ícone de bateria do GNOME": data["desativada"]["bateriaGnomeVisivel"],
    "desativar devolve o OSD original": data["desativada"]["osdOriginal"],
    "bloquear remove o relógio do Luma": data["bloqueada"]["ilhas"] == 0,
    "desbloquear recria 1 relógio do Luma": data["desbloqueada"]["ilhas"] == 1,
    "atalho da Prateleira registrado": d["atalhoPrateleira"],
    "desativar remove o atalho da Prateleira": not data["desativada"]["atalhoPrateleira"],
    "a bandeja de arquivos abre": data["comBandeja"]["bandejas"] == 1,
    "desativar fecha a bandeja de arquivos": data["desativada"]["bandejas"] == 0,
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
def first_frame(b):
    return next((l for l in b if l.lstrip().startswith("#0")), "")
# Nosso: a pilha passa pelo luma-menu@ — exceto quando o erro nasce no código
# de OUTRA extensão (#0 nela), só disparado por algo nosso (ex.: o gnome-mosaic
# reage a toda janela que se move).
ours = [b for b in blocks if any("luma-menu@" in l for l in b)
        and not ("/gnome-shell/extensions/" in first_frame(b) and "luma-menu@" not in first_frame(b))]
other = [b for b in blocks if not any("@file://" in l or "@resource://" in l for l in b[1:])]
for b in ours:
    print("\n".join(b)); print()
if not ours:
    print("(nenhum)")
print(f"(outros avisos novos: {len(blocks) - len(ours)}, dos quais {len(other)} sem pilha JS)")
'
