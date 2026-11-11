# Luma Menu — contexto do projeto

> Este arquivo é carregado automaticamente pelo Claude Code em toda sessão.
> A seção "Achados verificados" é mantida atualizada a cada fase; abaixo dela
> está a especificação original (o prompt do projeto).

## Estado do projeto

Fases 0–9 concluídas em 2026-11-10 (ver `git log`). Testado e aprovado pelo usuário na
sessão REAL. Pendências: Firefox não testado, envio ao extensions.gnome.org.
Fluxo de teste: `./scripts/nested-restart.sh && ./scripts/nested-test.sh 10`.

## Achados verificados no sistema (atualizar a cada fase)

Ambiente conferido em 2026-11-10: Fedora 45, GNOME Shell 51.1, Mutter 51.1, GJS 1.90.1, Wayland.

### APIs do Mutter 51 (conferidas no typelib `/usr/lib64/mutter-51/Meta-51.typelib`)
- **Existem**: `Meta.Window.get_gtk_unique_bus_name`, `get_gtk_menubar_object_path`,
  `get_gtk_app_menu_object_path`, `get_gtk_application_object_path`,
  `get_gtk_window_object_path`, `get_gtk_application_id`, `get_client_type`,
  `get_wm_class`, `get_sandboxed_app_id`, `get_pid`, `get_id`, `get_description`,
  `minimize`, `maximize`, `unmaximize`, `is_maximized`, `set_maximize_flags`,
  `make_fullscreen`, `unmake_fullscreen`, `is_fullscreen`, `make_above`,
  `unmake_above`, `is_above`, `delete`, `kill`, `change_workspace`, `move_to_monitor`.
  `Meta.Workspace.activate_with_focus` existe.
- **NÃO existem no GJS**: `Meta.Window.get_xwindow()` (o símbolo C
  `meta_window_x11_get_xwindow` existe, mas não é introspectável), `get_maximized()`
  (use `is_maximized()` / `get_maximize_flags()`), `Meta.Display.get_x11_display()`.
- `Meta.X11Display.lookup_xwindow(xid)` existe, mas não há getter público para
  obter o `X11Display` a partir do `Meta.Display`.
- **Como obter o XID na camada B**: `Meta.Window.get_description()`. As strings de
  formato no `libmutter-51.so` são `"0x%lx (%s)"` (janela X11: XID + título) e
  `"W%lu (%s)"` (janela Wayland). Extrair com `/^0x([0-9a-f]+)/i`.
  Confirmado em execução: Wayland `W0 (Calculadora)`, X11 `0x600007 (Reprodutor de Mídias VLC)`.

### GNOME Shell 51 — APIs usadas pelo menu (conferidas)
- `Shell.App`: `get_action_group()` (muxer com `app.*`/`win.*` das GActions do app),
  `update_window_actions(window)`, `request_quit()` (usa `app.quit` ou fecha as janelas),
  `can_open_new_window()`, `open_new_window(-1)`, `activate_action(name, param, 0, -1, null)`
  (promisificado pelo Shell), `get_windows()`, `create_icon_texture(size)`.
- `misc/systemActions.js`: `getDefault()` com `canSuspend/canRestart/canPowerOff/
  canLockScreen/canLogout` e `activateSuspend/Restart/PowerOff/LockScreen/Logout()`.
  Na sessão aninhada suspender/reiniciar/desligar ficam indisponíveis (sem sessão logind).
- Abrir painel das Configurações: `app.activate_action('launch-panel', av[(sav)])` como em
  `ui/status/network.js`; `gnome-control-center system about` é um subpage válido.
- Detalhes do app no GNOME Software: `org.gtk.Actions.Activate('details', [(ss)])` (ui/appMenu.js).
- `Main.wm.addKeybinding(name, settings, flags, modes, handler)` / `removeKeybinding(name)`.
  Conflitos: `<Control><Alt>Escape` = `cycle-panels` do Mutter; `F10` = menubar-accel/Ptyxis.
- PopupMenu: o `PopupMenuManager` faz `Main.pushModal(menu.actor)`; o setter `actor` de
  `PopupMenuBase` liga o destroy do ator ao do menu. BoxPointer `_reposition()` calcula
  posição em coordenadas de TELA (pai precisa estar na origem). Base dos submenus em
  cascata (`lib/popup.js`: raiz de tamanho zero contendo menu + cascatas).
- `Clutter.Actor.allocate_preferred_size(x, y)`; `St.Settings.enable_animations`;
  `animationUtils.adjustAnimationTime` zera durações com "Reduzir animação".
- CSS: `-st-accent-color` / `-st-accent-fg-color` existem no St 51.
- **`Clutter.get_default_backend()` NÃO existe no GNOME 51**: usar
  `global.stage.context.get_backend().get_default_seat()` (como `ui/screenShield.js`).
  Teclado virtual testado: F11 e digitação + Editar › Copiar funcionam.
- `Meta.Window.maximize()` e `unmaximize()` **sem parâmetros** no Mutter 51;
  `set_maximize_flags(directions)` existe. **Não há `Meta.TileMode`** nem API de tiling:
  "Metade esquerda/direita" sintetiza o atalho `org.gnome.mutter.keybindings
  toggle-tiled-left/right` do usuário (fallback: `move_resize_frame`).
- `Meta.Window.change_workspace_by_index(i, append)`, `move_to_monitor(i)`,
  `raise()`, `activate(time)`, `delete(time)`; `Main.activateWindow(window)`.
- GTK4/libadwaita (ex.: Editor de Texto) só exporta ações `app.*`: as `win.*` são
  widget actions, não vão para o D-Bus (o grupo da janela vem vazio).
- Camada A testada com `dev/test-apps/gtk-menubar-app.js` (GTK4 + `set_menubar`):
  o Mutter expõe `get_gtk_menubar_object_path()` em Wayland; `Gio.DBusMenuModel.get()`
  e `Gio.DBusActionGroup.get()` funcionam (leitura assíncrona via `items-changed`).
  Ações booleanas, rádio (alvo) e `win.*` (GActionMap da janela) testadas.
- Apps sem `.desktop` são "window backed" (`app.is_window_backed()`, id `window:N`):
  nome amigável = fim do WM_CLASS (`appDisplayName`).
### Camada B e apps reais (testado na Fase 6)
- Registrar (`lib/sources/registrar.js`) exporta `com.canonical.AppMenu.Registrar`;
  métodos com sufixo `Async` recebem `invocation` (sender = serviço do menu).
- VLC (Qt5, `QT_QPA_PLATFORM=xcb`): registra `/MenuBar/N`; menus com ícones (`icon-data`).
  Rótulos Qt podem trazer `&` de mnemônico (tratado em `cleanLabel`).
- VS Code (Electron, `--ozone-platform=x11` + `window.titleBarStyle: native`): registra
  `/com/canonical/menu/<XID>`. Submenus vêm VAZIOS até `AboutToShow`; ele responde
  `false` mas preenche e emite `LayoutUpdated`. Por isso: AboutToShow só ao ABRIR
  (`onOpen`), nunca ao montar o modelo (senão vira ciclo); submenu vazio → `GetLayout(id)`.
- LibreOffice (GTK3, Wayland nativo): usa a CAMADA A; os menus de topo ficam dentro de
  uma SEÇÃO da barra (getMenus desce nas seções).
- Apps Qt/Electron só registram ao abrir: desativar/reativar a extensão (que recria o
  Registrar) perde os menus deles até reabrir o app. Por isso `session-modes` inclui
  `unlock-dialog`: no bloqueio só o Registrar fica vivo (testado: menus sobrevivem).
- Firefox não foi testado (o perfil do usuário já está em uso na sessão real).
- Ptyxis: perfil de terminal testado (Copiar = Ctrl+Shift+C, Recortar cinza).
- O sistema do usuário tem o diário do gvfs-metadata corrompido (avisos
  `meta_journal_iterate … journal corruption` no `gnome-extensions pack`): inofensivo.

### Preferências (Fase 8)
- libadwaita 1.10, GTK 4.24. `ExtensionPreferences.fillPreferencesWindow(window)` recebe
  um `Adw.PreferencesWindow`. Testar: `Main.extensionManager.openExtensionPrefs(uuid,'',{})`
  via Eval abre a janela DENTRO da sessão aninhada.
- Fora do app Extensões o `gettext` de prefs.js falha ("only be called from extensions");
  uma ferramenta de prévia separada travou no fill — foi descartada.
- Mudanças nas preferências testadas ao vivo (ícone, estilo, tamanho, espaçamento, atalhos).
- `pgrep -f`/`pkill -f` com padrão que aparece na própria linha de comando matam o
  shell da ferramenta (exit 144): usar PID (`$!`) ou `ps -eo pid,args | awk '$2==...'`.

### Painel (Fase 6)
- `Panel.vfunc_allocate` limita a caixa da esquerda a METADE do painel. A barra
  sobrescreve `vfunc_allocate` para transbordar até o 1º item visível do centro/direita
  (`clip_to_allocation` evita desenhar por cima dos ícones).
- `PanelMenu.ButtonBox` calcula a largura em JS: `min-width`/`max-width` no BOTÃO são
  ignorados — aplicar no rótulo (`.luma-menu-app-label`).
- Just Perfection move o relógio ao iniciar (e tem guarda `child-added` nas caixas);
  o PanelLayout reaplica (máx. 3 em 10 s) e confere de novo após 3 s.
- Ao desbloquear, o painel mostra o botão Atividades de novo: re-esconder em `notify::visible`.
- - Iniciar programa dentro da sessão aninhada: `GLib.spawn_command_line_async(...)` via
  Eval (o Shell aninhado tem `WAYLAND_DISPLAY=wayland-1`, `DISPLAY=:2` e o barramento dele).
- GJS 1.90 NÃO promisifica tudo: usar `Gio._promisify` (ex.: `load_contents_async`).
- `Gio.DBus.session` / `Gio.DBus.system` reaproveitam a conexão do Shell (sem chamada síncrona).
- Informações do sistema: hostnamed (`HardwareVendor/HardwareModel/KernelRelease`) e
  switcheroo-control (`GPUs`) respondem neste notebook.

### GNOME Shell 51 — painel e extensões (conferido no JS extraído do `libshell-51.so`)
- Para ler o código JS do Shell: `gresource list /usr/lib64/gnome-shell/libshell-51.so`
  e `gresource extract … <arquivo>`.
- `Main.panel._leftBox/_centerBox/_rightBox` (privados). `addToStatusArea(role, indicator,
  position, box)` só aceita um `PanelMenu.Button`.
- O `ActivitiesButton` contém os `WorkspaceIndicators`: escondê-lo some com os dois.
  O ator a esconder/inserir é `button.container` (St.Bin), não o botão.
- `PanelMenu.Button._init(menuAlignment, nameText, dontCreateMenu)`; com
  `dontCreateMenu=true` o menu é um `PopupDummyMenu` (não registrar no menuManager).
- `PopupMenuManager.addMenu()` remove o menu sozinho no `destroy` dele.
- Padding dos botões: propriedades CSS `-natural-hpadding` / `-minimum-hpadding`.
  O tema usa `#panel .panel-button`; para vencer: `#panel .panel-button.luma-menu-…`.
- St recolore como simbólico arquivos que terminam em `-symbolic.svg` (confirmado no libst).
- `ExtensionBase` chama `initTranslations()` no construtor (usa `gettext-domain` do
  metadata.json e a pasta `locale/`). `gettext` importado de `extension.js` acha a
  extensão pela pilha de chamadas (precisa do caminho `/gnome-shell/extensions/`).
- Estados (`Main.extensionManager.lookup(uuid).state`): 1 = ACTIVE, 2 = INACTIVE.
- Extensões com `session-modes` padrão são desativadas ao bloquear a tela
  (`unlock-dialog`) e reativadas ao desbloquear. Testado: a barra não duplica.
- `gnome-extensions enable <uuid>` falha ("não existe") se a sessão em execução não
  carregou a extensão no login — por isso o dev usa o dconf isolado (abaixo).

### Sessão aninhada (mutter-devkit) — fluxo de desenvolvimento
- `./scripts/dev-nested.sh`: empacota, instala, cria dconf isolado e abre o Shell aninhado.
  Comando base: `dbus-run-session -- gnome-shell --devkit --wayland --devkit-args="--monitor-size=1600x1000"`.
- dconf isolado: copia `~/.config/dconf/user` → `~/.config/dconf/luma_menu_dev` e usa
  `DCONF_PROFILE` (arquivo com `user-db:luma_menu_dev`). O nome do banco **não pode ter
  hífen** (vira caminho D-Bus `/ca/desrt/dconf/Writer/<nome>`; com hífen o `gsettings set` trava).
- `dev/luma-menu-devtools@viniciusbispo19`: liga `global.context.unsafe_mode` só com
  `LUMA_MENU_DEV=1`. Isso libera `org.gnome.Shell.Eval` e `org.gnome.Shell.Screenshot`.
- `./scripts/nested-eval.sh '<js>'` e `./scripts/nested-screenshot.sh [png]` falam com o
  Shell aninhado pelo endereço salvo em `~/.local/state/luma-menu/nested-bus`.
  No escopo do Eval existem `Main`, `global`, `Shell`, `Meta`, mas NÃO `Clutter` nem `St`
  (para criar um ator: `new (Main.panel._centerBox.constructor)({...})` = St.BoxLayout).
- `./scripts/nested-test.sh [ciclos]`: ativa/desativa N vezes + bloqueio simulado e
  só acusa avisos cuja pilha JS passa pelo `luma-menu@` (usa `SHELL_DEBUG=backtrace-warnings`).
- `./scripts/nested-stop.sh`: encerra só o Shell aninhado. NUNCA usar
  `pkill -f 'gnome-shell --devkit'` (o padrão casa com o próprio shell e o mata).
- dconf: cada barramento tem seu `dconf-service` com o banco em memória; por isso a
  cópia e as escritas no banco isolado são feitas DENTRO do barramento aninhado.
- Logs da sessão aninhada: `~/.local/state/luma-menu/nested-*.log`.
- `MUTTER_DEBUG_DUMMY_MODE_SPECS` **não existe mais** no Mutter 51 (tutoriais antigos).
- Ruído pré-existente no log (não é culpa do Luma Menu): `copyous@boerdereinar.dev` falha
  ao importar `highlight.min.js` e gera `No object to track signals`; `dynamic-calendar…`
  gera `setSourceSurface … Not an object`; `hiragana-clock` gera
  `meta_workspace_get_work_area_for_monitor` CRITICAL; Luma Dock gera
  `LumaBackground … needs an allocation`; milhares de `Overwriting existing binding of keysym`.

### Funções do Isle na barra do macOS (projeto 2 — plano em ~/.claude/plans/playful-purring-abelson.md)
- **ATUAL (2026-11-11, decisão final do usuário)**: menus da barra E relógio abrem o
  POP-UP padrão do GNOME (balão, `LumaMenu`; o relógio usa `alignment 1.0`), com o desfoque
  do Blur my Shell. `island-menus` agora é `false` por padrão (código da forma ainda existe
  como opção). A forma do Isle (`IslandSurface`) continua só nos ALERTAS. Abaixo, histórico.
- **Integração com o Blur my Shell nos pop-ups**: o BMS escreve na caixa do menu
  (`set_style`) um `border-radius` igual ao do vidro dele (`menu-corner-radius` 20) e pinta o
  fundo pela classe (`rgba(30,30,33,.5) !important`). `LumaMenu._applyAppearance` NÃO toca
  no estilo de caixas com `bms-popup-blurred` (antes apagava o raio e cobria o vidro).
  Sem sombra e sem a margem do WhiteSur (`.popup-menu-content` margin 4/12/17px) — viravam
  uma "moldura" escura. `-boxpointer-gap: 0` (encostado na barra).
- Pop-up do relógio rente ao canto direito: `boxPointer.setSourceAlignment(1.0)` (o balão
  mirava o CENTRO do botão; `margin = 4·-arrow-border-radius` no `_reposition`).
- Bateria MONOCROMÁTICA (pedido do usuário): raio recortado no preenchimento.
- **Layout decidido pelo usuário (2026-11-11)**: NADA no centro da barra. **Barra preta
  sólida** (chave `black-bar`, padrão ligado; `PanelLayout` acrescenta só a sua declaração
  ao `Main.panel.style` e a tira no destroy). Relógio do Luma no CANTO DIREITO (último
  item de `_rightBox`, `addToStatusArea('luma-menu-clock')`, peso normal). **Clique**
  faz a forma PRETA do Isle sair de baixo do relógio (`islandShape.js`: chrome desenhado
  com Cairo — corpo, cantos 28 px, ombros côncavos na borda de baixo da barra —, mola,
  borda direita presa ao relógio, cresce para baixo/esquerda). Cabeçalho na altura da
  barra: abas à esquerda + cópia da data/hora no mesmo lugar do relógio. Esc/clique
  fora: `GrabHelper` do Shell (`ui/grabHelper.js`, `grab({actor, onUngrab})`). Alertas
  (Fase 2) saem do mesmo lugar, mesma forma. Sem hover.
- **Visual atualizado (2026-11-11, pedido do usuário)**: barra = preto FUMÊ (`black-bar-opacity`,
  padrão 85%) para o desfoque do Blur my Shell aparecer; forma do relógio E menus da barra
  (`island-menus`) saem da barra como vidro fumê. Peça comum: `lib/island/surface.js`
  (`IslandSurface`): desfoque ESTÁTICO (cópia do papel de parede via
  `Background.BackgroundManager` + `Shell.BlurEffect` radius 60·escala, brilho 0,6 — igual ao
  BMS do painel), recortado por máscara GLSL (`shapeMask.js`, `Clutter.ShaderEffect` +
  `vfunc_get_static_snippet`), tinta por cima (Cairo), faixa da barra NÃO pintada. Cor:
  `barLook.js` (preto fumê ou cor do tema do painel com a barra preta desligada).
- Desfoque `BACKGROUND` não pode ser recortado por outro efeito (o recorte desenha num
  FBO sem "fundo"): por isso o desfoque é de uma cópia do papel de parede.
- Área do desfoque: `vfunc_get_paint_volume` = `volume.set_from_allocation(this)` (sem
  `clip_to_allocation`). Altura 0 → esconder (senão `cogl_framebuffer_set_viewport` CRITICAL).
- **Blur my Shell 78 desfoca todo popup cuja caixa (`_delegate.box`) tem `popup-menu-content`**
  (classe `bms-popup-blurred`) e desenha o vidro dele por cima. Opt-out: tirar
  `popup-menu-content` da caixa no CONSTRUTOR do menu (o BMS decide no `child-added` do
  uiGroup). Os submenus em cascata continuam com a classe (o BMS desfoca). Opt-in oficial
  do BMS para outras extensões: classe `bms-popup-blur-target`.
- O BMS reescreve `Main.panel.style` (tira o `;` final): remover a nossa regra por regex.
- `get_transformed_position()` de ator sem alocação devolve NaN; menu aberto antes do título
  ter alocação faz o BoxPointer alocar NaN → `LumaMenu.open` recusa sem `has_allocation()`.
- **Fase 2a concluída (2026-11-11)**: `alerts.js` (AlertPresenter: IslandSurface que sai do
  relógio; reaproveita `BarLevel` de `ui/barLevel.js`, com `overdrive` acima de 100%),
  `services/osdOverride.js` (InjectionManager em `Main.osdWindowManager.show/showAll/showOne`;
  ícones `audio-volume*`, `display-brightness*`, `keyboard-brightness*`; o resto e tela
  cheia/painel aberto → OSD original), `services/power.js` (UPower DisplayDevice +
  `org.freedesktop.UPower.PowerProfiles`, XML via `loadInterfaceXML` do Shell),
  `batteryIcon.js` (Cairo; esconde `quickSettings._system`; subtítulo no `powerToggle`),
  `services/weather.js` (GWeather.Info próprio; `get_conditions()` ou `get_sky()` já vêm em
  pt-BR; ícone `get_symbolic_icon_name()` com dia/noite; cache em `weather-cache`).
- Âncora de alertas: medir o relógio NA HORA (`notify::allocation` do botão não dispara
  quando só o contêiner anda).
- No Eval, `imports.gi.Gio` existe (útil para simular OSD: `Main.osdWindowManager.showAll(
  new (imports.gi.Gio.ThemedIcon)({name:'audio-volume-medium-symbolic'}), null, 0.5, 1)`).
- O notebook do usuário fica na tomada com carga completa (UPower State 4): bateria verde
  com raio é o esperado.
- NÃO usar `trackFullscreen` em chrome que fica escondido: o LayoutManager força
  `visible` ao sair da tela cheia.
- `PanelMenu.Button` sem menu (`dontCreateMenu`) desliga o ClickGesture dele: o relógio
  tem o próprio `Clutter.ClickGesture` (recognize_on_press). Padding do botão do painel:
  `get_theme_node().get_length('-natural-hpadding')`.
- Fases 1 e 2a concluídas. Próximas: 2b (Música portada do wavebar-music, Notificações),
  2c (Foco, Lembretes, demais alertas), 3 (prefs completas; perguntar antes).
- `PopupMenu.close()` emite `menu-closed` só DEPOIS da animação (útil se voltar a usar menu).
- `Main.layoutManager.addChrome(actor, params)` no GNOME 51 aceita só `trackFullscreen` e
  `affectsStruts` (`affectsInputRegion` NÃO existe mais → erro "Unrecognized parameter").
- `St.ButtonMask.ONE/TWO/THREE` estão obsoletos: usar `PRIMARY/MIDDLE/SECONDARY`.
- Fonte do tema pode ser absoluta (WhiteSur: "Inter Medium 13.333px") →
  `font.get_size_is_absolute()` decide px ou pt.
- Calendário da ilha EMPRESTA `dateMenu._calendar` e `dateMenu._clocksItem` e usa
  `dateMenu._eventSource` (o `Calendar.Calendar` do Shell nunca desconecta o GSettings:
  criar outro vazaria). Devolver antes de destruir a ilha (feito também no 'destroy').
- CalendarServer só entrega id/título/início/fim (sem descrição/local): link de reunião
  exige `gi://ECal` (decidido: sob demanda, assíncrono).
- `Source` emite `notification-added` antes de `notification-request-banner`; o MessageTray
  ignora notificações com `acknowledged = true` (assumir banners sem remendar o tray).
- Brilho no GNOME 51: `Main.brightnessManager` (sinais `changed`/`user-update`);
  `org.gnome.SettingsDaemon.Power.Screen` NÃO existe (gsd-power só tem `Power.Keyboard`).
- Volume: `getMixerControl()` de `ui/status/volume.js`. OSD: `Main.osdWindowManager.show/
  showAll/showOne`. Bateria: `Main.panel.statusArea.quickSettings._system` (criado async).
- Clima: GWeather-4.0 e Geoclue-2.0 disponíveis; `org.gnome.shell.weather` tem Salvador.
  A `WeatherClient` do Shell não tem destroy() → fazer cliente próprio com `GWeather.Info`.
- PowerProfiles via tuned-ppd (`net.hadess.PowerProfiles` e `org.freedesktop.UPower.PowerProfiles`).
- Ator de chrome com animação rodando: parar antes de `removeChrome` (senão: "Timelines
  with detached actors") — vale para a caixinha de alertas.
- Extensões do usuário que tocam no relógio/música: `hiragana-clock` (esconde
  `dateMenu.container`) e `wavebar-music` (dele, GPL-3.0-or-later; MPRIS + LRCLIB).
- Isle clonado em `/tmp/isle-ref` (GPL-3.0) só como referência: NÃO copiar código.

### Ícones
- Fedora: Simple Icons 16.37.0 (`path` copiado por script, nunca à mão). O Simple Icons
  marca a licença do logo como **custom** (regras de marca do Fedora), não CC0 — ver
  `icons/CREDITS.md`. Repetir essa checagem (campo `license` em `data/simple-icons.json`)
  para cada logo da Fase 8.

### Extensões do usuário
- Ativas: blur-my-shell, caffeine, appindicatorsupport, compiz-windows-effect,
  just-perfection, slider-percentages, gnome-mosaic, copyous, user-theme,
  launchpad-search, dynamic-calendar-and-clocks-icons-reborn, luma-dock,
  hiragana-clock.
- Astra Monitor **não está instalada** neste momento.
- `globalmenu@ShiroOSL.github.io` (Global Menu for GNOME v26) instalada e **desativada**.
  Ela só implementa a camada D (menus fixos + teclado virtual do Clutter); não lê menus
  reais dos apps; usa `Gio.DBusProxy.new_for_bus_sync` (síncrono) no painel de informações.

### Ferramentas
- Presentes: git, gh (logado como viniciusbispo19, protocolo ssh), glib-compile-schemas,
  gettext (msgfmt/xgettext/msginit/msgmerge), node/npm, gnome-extensions, gdbus, busctl,
  dbus-monitor.
- ESLint **não existe no dnf** do Fedora 45 → `npm install` (eslint 10.14.0 fixo no
  package.json). Rodar com `npm run lint`. Config em `eslint.config.js` (estilo GNOME).
- Build/instalação: `scripts/build.sh` (`gnome-extensions pack`, compila po/ → .mo),
  `scripts/install.sh` (pack + install; NUNCA symlink — `install --force` apagaria o
  projeto), `scripts/update-po.sh` (xgettext + msgmerge).
- Instalados: `d-spy` 50.0 (explorador D-Bus), `gnome-extensions-app`, `libdbusmenu-tools`.
  Atenção: o `libdbusmenu-tools` do Fedora **não** traz o `dbusmenu-dumper`; traz
  `/usr/libexec/dbusmenu-testapp` (publica um DBusMenu a partir de um JSON, ex.:
  `/usr/share/libdbusmenu/json/test-gtk-label.json`) — útil para testar a camada B.
- Disponível no dnf (não instalado): `appmenu-qt5` (só Qt5; Qt6 já traz suporte a DBusMenu embutido).
- `appmenu-gtk-module` (appmenu-gtk3-module) **não está nos repositórios** do Fedora 45.

---

# Especificação original

## 1. Seu papel

Você é um desenvolvedor sênior de extensões do GNOME Shell (GJS, ES Modules, St, Clutter, Meta, Gio/DBus, libadwaita) e também meu professor. Eu sou estudante de desenvolvimento e quero **aprender a fazer sozinho**, então:

- Explique o **porquê** de cada decisão, cada arquivo e cada trecho importante de código, em português do Brasil.
- Coloque **comandos de terminal sempre em blocos de código separados** das explicações, para eu copiar e colar sem risco.
- Meu sistema é Fedora: use `dnf` para pacotes (nunca `apt`).
- Quando entregar uma etapa de instalação/configuração, entregue **todos os passos de uma vez, completos**.
- Não invente APIs. Antes de usar qualquer método do GNOME Shell/Mutter, **confira se ele existe no GNOME 51** (código-fonte do gnome-shell/mutter da versão 51 ou o `gjs-docs`). Se algo não for possível, me diga claramente e proponha a melhor alternativa.

## 2. Objetivo

Criar do zero a extensão **Luma Menu** (UUID `luma-menu@viniciusbispo19`, schema `org.gnome.shell.extensions.luma-menu`, licença GPL-3.0), que transforma o lado esquerdo do painel superior do GNOME em uma **barra de menus global praticamente idêntica à do macOS**, com:

1. Um **ícone de sistema Linux** no lugar da maçã (logo do Fedora por padrão, configurável).
2. O **nome do app ativo em negrito**, com o menu do aplicativo.
3. Os menus **Arquivo, Editar, Visualizar, Janela e Ajuda** (e os menus reais do app quando ele os exportar).
4. **Toda a interface em português do Brasil**, traduzível via gettext.

## 3. Meu ambiente

- Fedora 45, GNOME Shell **51.1**, sessão **Wayland**.
- Notebook Lenovo Yoga Slim 6i, tela 14" de alta resolução (escala fracionária possível — a barra tem que ficar nítida em qualquer escala).
- Tema GTK + Shell: **WhiteSur-Dark** (via extensão User Themes).
- Extensões que precisam continuar funcionando junto: **Luma Dock** (meu fork do Dhruva), Blur my Shell, Just Perfection, AppIndicator and KStatusNotifierItem Support, Caffeine, Astra Monitor.
- Tenho a extensão **Global Menu for GNOME** instalada: o Luma Menu vai substituí-la. No início, me mostre como desativá-la para não haver conflito.

## 4. Realidade técnica (leia antes de projetar)

No macOS todo app entrega seu menu ao sistema. No Linux/Wayland não existe um padrão único, então a extensão deve usar **camadas de fonte de menu**, da melhor para a mais genérica, e escolher automaticamente para cada janela:

| Camada | Fonte | Apps típicos | Como obter |
|---|---|---|---|
| A | **GMenuModel exportado via D-Bus (`org.gtk.Menus`)** + ações (`org.gtk.Actions`) | Apps GTK3/GTK4 que usam `GtkApplication` com menubar ou app menu | Pelo `Meta.Window`: `get_gtk_unique_bus_name()`, `get_gtk_menubar_object_path()`, `get_gtk_app_menu_object_path()`, `get_gtk_application_object_path()`, `get_gtk_window_object_path()` (verifique os nomes no Mutter 51) |
| B | **DBusMenu (`com.canonical.dbusmenu`)** registrado em `com.canonical.AppMenu.Registrar` | Apps Qt/KDE, Electron/Chromium, Firefox, LibreOffice, apps GTK3 com `appmenu-gtk-module` — **principalmente via XWayland** | A própria extensão implementa o serviço `com.canonical.AppMenu.Registrar` no barramento de sessão e associa o ID de janela X11 (`Meta.Window.get_xwindow()` ou equivalente) à janela ativa |
| C | **Ações GAction do app sem menubar** | Apps GNOME/libadwaita modernos (menu hambúrguer) | Ler `org.gtk.Actions` no caminho da aplicação e da janela; mapear ações conhecidas: `app.about`, `app.preferences`, `app.quit`, `app.new-window`, `win.show-help-overlay`, `app.shortcuts`, `win.close`, etc. |
| D | **Menu padrão macOS (fallback)** | Qualquer janela | Itens executados por: (1) GAction, se existir; (2) API do Mutter (`minimize`, `maximize`, `make_fullscreen`, `delete`, `change_workspace`…); (3) atalho de teclado sintetizado via dispositivo virtual do Clutter (ex.: Ctrl+C), como último recurso |

Requisitos sobre isso:
- Documente no README o que funciona em Wayland nativo vs XWayland, sem promessas falsas.
- Itens cujo efeito não dá para garantir devem ficar **desabilitados (cinza)**, como no macOS, em vez de não fazer nada.
- Estude como referência (sem copiar código sem respeitar a licença): o antigo projeto **Fildem** e a extensão **Global Menu for GNOME** que já tenho instalada. Me explique o que cada um fazia certo e errado.

## 5. Especificação visual

- A barra global ocupa o **lado esquerdo do painel superior**; o botão "Atividades"/indicador de áreas de trabalho é ocultado (com opção de manter).
- O relógio e o menu de status do GNOME ficam à direita, como no macOS. Opção de mover o relógio para a direita.
- Tipografia: fonte do sistema, nome do app em **negrito**, demais menus em peso normal, espaçamento horizontal parecido com o do macOS (~10–14 px entre títulos).
- Menus suspensos: cantos arredondados (~10 px), fundo translúcido escuro compatível com Blur my Shell e WhiteSur-Dark, separadores finos, destaque azul no item sob o mouse, **atalho alinhado à direita** em cinza, setas `›` para submenus, marca `✓` para itens marcáveis.
- Todo o estilo em `stylesheet.css`, com variáveis/classes bem nomeadas, respeitando tema claro e escuro.
- Animação curta de abertura (fade + leve deslocamento, ~120 ms), respeitando a opção "Reduzir animação" do GNOME.

## 6. Comportamento (igual ao macOS)

- Clicar abre o menu; com um menu aberto, **passar o mouse** sobre outro título troca de menu sem clicar.
- Navegação por teclado: **F10** foca a barra (configurável), setas navegam, Enter ativa, Esc fecha, letras sublinhadas/mnemônicos opcionais.
- A barra **acompanha a janela em foco** imediatamente (sinais `notify::focus-window` do `global.display`), inclusive ao trocar de área de trabalho e de monitor.
- Sem janela em foco (área de trabalho vazia): mostra o menu do **Arquivos (Nautilus)**, como o Finder no macOS.
- Em multimonitor: opção de mostrar a barra só no monitor principal ou em todos.
- Nada de vazamento: desconectar **todos** os sinais, proxies D-Bus e timers no `disable()`.

## 7. Menus — conteúdo completo

Os atalhos abaixo são os do Linux/GNOME. Ofereça nas preferências a opção de exibir no estilo texto (`Ctrl+C`, padrão) ou com símbolos estilo Mac (`⌃C`, `⇧`, `⌥`, `❖` para Super).

### 7.1 Menu do sistema (ícone Linux, no lugar da )
- **Sobre Este Computador** — janela própria estilo "Sobre Este Mac": logo da distro, nome e versão (`/etc/os-release`), modelo do computador, processador, memória, placa de vídeo, disco, versão do GNOME e do kernel, botão "Mais Informações…" que abre Configurações › Sistema › Sobre.
- separador
- **Configurações do Sistema…**
- **Central de Programas…** (GNOME Software)
- separador
- **Itens Recentes ›** — Aplicativos recentes e Documentos recentes (ler `~/.local/share/recently-used.xbel`), + "Limpar Menu"
- separador
- **Forçar Encerramento…** — `Ctrl+Alt+Esc`: janela própria que lista os apps abertos, igual à do macOS, com botão "Forçar Encerramento"
- separador
- **Suspender**
- **Reiniciar…**
- **Desligar…**
- separador
- **Bloquear Tela** — `Super+L`
- **Encerrar Sessão de "<nome do usuário>"…** — `Ctrl+Alt+Del`

(Use as APIs do próprio GNOME Shell/logind para suspender, reiniciar, desligar e bloquear, mantendo os diálogos de confirmação nativos.)

### 7.2 Menu do aplicativo (nome do app em negrito)
- **Sobre o <App>**
- separador
- **Configurações…** — `Ctrl+,`
- separador
- **Ocultar <App>** — `Super+H` (minimiza todas as janelas do app)
- **Ocultar Outros** — minimiza as janelas dos demais apps
- **Mostrar Tudo**
- separador
- **Sair do <App>** — `Ctrl+Q`

### 7.3 Arquivo
- Nova Janela — `Ctrl+N`
- Nova Aba — `Ctrl+T`
- Abrir… — `Ctrl+O`
- Abrir Recentes ›
- separador
- Fechar Janela — `Ctrl+W`
- Fechar Todas — `Ctrl+Shift+W`
- Salvar — `Ctrl+S`
- Salvar Como… — `Ctrl+Shift+S`
- separador
- Imprimir… — `Ctrl+P`

### 7.4 Editar
- Desfazer — `Ctrl+Z`
- Refazer — `Ctrl+Shift+Z`
- separador
- Recortar — `Ctrl+X`
- Copiar — `Ctrl+C`
- Colar — `Ctrl+V`
- Colar sem Formatação — `Ctrl+Shift+V`
- Apagar
- Selecionar Tudo — `Ctrl+A`
- separador
- Buscar › (Buscar… `Ctrl+F`, Buscar Próximo `Ctrl+G`, Buscar Anterior `Ctrl+Shift+G`, Buscar e Substituir… `Ctrl+H`)
- separador
- Emoji e Símbolos — `Ctrl+.` / abre o seletor de emoji ou o app Caracteres

### 7.5 Visualizar
- Mostrar/Ocultar Barra Lateral — `F9`
- separador
- Ampliar — `Ctrl++`
- Reduzir — `Ctrl+-`
- Tamanho Real — `Ctrl+0`
- separador
- Entrar em Tela Cheia / Sair da Tela Cheia — `F11` (texto muda conforme o estado)

### 7.6 Janela
- Minimizar — `Super+H`
- Zoom (Maximizar/Restaurar)
- separador
- Mover para a Metade Esquerda da Tela — `Super+←`
- Mover para a Metade Direita da Tela — `Super+→`
- Mover para o Próximo Monitor (só se houver mais de um)
- Mover para Área de Trabalho › (lista das áreas de trabalho)
- Sempre no Topo (marcável ✓)
- separador
- Trazer Tudo para a Frente
- separador
- Lista das janelas abertas do app, com `✓` na janela ativa (clicar foca a janela)

### 7.7 Ajuda
- **Campo de busca no topo**, como no macOS: ao digitar, pesquisa em **todos os itens de menu do app atual** (todas as camadas) e mostra os resultados com o caminho (ex.: `Editar › Buscar › Buscar…`); Enter executa o item.
- Ajuda do <App> — `F1` (abre o Yelp quando houver ajuda instalada)
- Atalhos de Teclado — `Ctrl+?` (GAction `win.show-help-overlay`/`app.shortcuts` quando existir)

### 7.8 Menus reais do app
Quando o app exportar menus próprios (camadas A/B), **eles substituem Arquivo…Ajuda**, mantendo sempre o menu do sistema, o menu do app em negrito (mesclando "Sobre", "Configurações" e "Sair" se o app tiver esses itens) e o campo de busca no menu Ajuda. Traduza só os rótulos que vierem do fallback; os rótulos do app vêm traduzidos pelo próprio app.

## 8. Ícones do sistema (no lugar da maçã)

- Opções no seletor das preferências, com prévia: **Fedora** (padrão), **Tux**, **GNOME**, **Ubuntu**, **Debian**, **Arch Linux**, **openSUSE**, **Linux Mint**, **Pop!_OS**, **Manjaro**, **NixOS**, **Zorin OS**, **elementary OS**, **Automático** (detecta a distro pelo `ID` do `/etc/os-release` e usa o ícone `distributor-logo`/`fedora-logo-icon` do sistema quando existir) e **Personalizado** (escolher um arquivo SVG/PNG).
- Ícones em SVG **simbólico** (monocromático, recolorido pelo tema) dentro de `icons/`, com opção "colorido".
- Para os logos, use fontes com licença compatível (ex.: Simple Icons, CC0) e registre a origem e a licença de cada arquivo em `icons/CREDITS.md`, lembrando que marcas registradas continuam pertencendo aos donos.
- Tamanho ajustável (14–22 px), alinhado verticalmente com o texto da barra.

## 9. Preferências (`prefs.js` com libadwaita)

Páginas organizadas, tudo em pt-BR:
- **Geral**: ativar/desativar menus padrão (fallback), mostrar em todos os monitores, ocultar botão Atividades, posição do relógio, atalho para focar a barra.
- **Aparência**: ícone do sistema (com prévia), tamanho do ícone, simbólico/colorido, estilo dos atalhos (texto ou símbolos ⌃⇧⌥), negrito no nome do app, espaçamento, opacidade/arredondamento dos menus.
- **Menus**: ligar/desligar cada menu (Arquivo, Editar, Visualizar, Janela, Ajuda), busca no menu Ajuda, itens do menu do sistema.
- **Compatibilidade**: ativar o Registrar DBusMenu (camada B), lista de apps ignorados (por `app_id`/`WM_CLASS`), modo de depuração com logs.
- **Sobre**: versão, autor, link do GitHub (`github.com/viniciusbispo19`), licença.

Todas as opções salvas em GSettings (`schemas/org.gnome.shell.extensions.luma-menu.gschema.xml`) e aplicadas **ao vivo**, sem precisar reiniciar a sessão.

## 10. Tradução

- Todas as strings visíveis com `gettext` (`_()`), domínio `luma-menu`.
- Arquivo `po/pt_BR.po` completo + `po/luma-menu.pot`.
- Script para compilar as traduções e empacotar com `gnome-extensions pack`.

## 11. Estrutura de arquivos esperada

```
luma-menu/
├── metadata.json            # shell-version: ["51"] (e "50" se for compatível de verdade)
├── extension.js             # enable()/disable(), monta a barra
├── prefs.js                 # janela de preferências (Adw)
├── stylesheet.css
├── lib/
│   ├── menuBar.js           # barra e lógica de abrir/trocar menus
│   ├── systemMenu.js        # menu do ícone Linux
│   ├── appMenu.js           # menu do app em negrito
│   ├── fallbackMenus.js     # Arquivo/Editar/Visualizar/Janela/Ajuda padrão
│   ├── sources/
│   │   ├── gtkMenuSource.js     # camada A (org.gtk.Menus/Actions)
│   │   ├── dbusMenuSource.js    # camada B (com.canonical.dbusmenu)
│   │   ├── registrar.js         # serviço com.canonical.AppMenu.Registrar
│   │   └── actionSource.js      # camada C (GActions conhecidas)
│   ├── windowTracker.js     # janela/app em foco
│   ├── actions.js           # executar ações (GAction, Mutter, teclado virtual)
│   ├── menuSearch.js        # busca do menu Ajuda
│   ├── aboutDialog.js       # "Sobre Este Computador"
│   └── forceQuitDialog.js   # "Forçar Encerramento"
├── icons/                   # logos SVG + CREDITS.md
├── schemas/
├── po/
├── scripts/                 # build, install, pack, compile-translations
├── README.md                # em pt-BR, com limitações explicadas
└── LICENSE                  # GPL-3.0
```

## 12. Qualidade e compatibilidade

- Seguir as **regras de revisão do extensions.gnome.org** (nada criado fora do `enable()`, tudo destruído no `disable()`, sem `Main` modificado sem restaurar, sem código síncrono pesado no thread principal).
- Chamadas D-Bus **assíncronas** e com tratamento de erro (app fechou, menu sumiu, bus caiu) — a barra nunca pode travar o Shell.
- Cache de menus por janela, atualizado pelos sinais de mudança (`Changed`, `LayoutUpdated`, `ItemsPropertiesUpdated`).
- Não quebrar Luma Dock, Blur my Shell e Just Perfection; testar com todas ativas.
- Código comentado em português, explicando o porquê.
- ESLint configurado com o estilo do GNOME Shell.

## 13. Como trabalhar comigo (fases)

Trabalhe em fases. Ao final de cada fase: me diga o que foi feito, como testar, o que aprender ali, e **espere eu confirmar** que funcionou antes de seguir.

1. **Fase 0 — Preparação**: pacotes necessários (via `dnf`), como desativar a Global Menu for GNOME, criação do projeto e do repositório Git/GitHub, como testar a extensão numa sessão aninhada no GNOME 51 (modo devkit) sem derrubar minha sessão, e como ver os logs (`journalctl`).
2. **Fase 1 — Esqueleto**: `metadata.json`, `extension.js` mínimo, barra vazia no painel, ícone do Fedora.
3. **Fase 2 — Menu do sistema** completo, incluindo "Sobre Este Computador" e "Forçar Encerramento".
4. **Fase 3 — Rastreamento de janela** + menu do app em negrito.
5. **Fase 4 — Menus padrão (camada D)** com todas as ações.
6. **Fase 5 — Camadas A e C** (GTK/GActions).
7. **Fase 6 — Camada B** (Registrar + DBusMenu para XWayland).
8. **Fase 7 — Busca no menu Ajuda**.
9. **Fase 8 — Preferências** completas.
10. **Fase 9 — Tradução pt-BR**, empacotamento, README e checklist para publicar no extensions.gnome.org.

## 14. Critérios de aceite

- Com Nautilus, Editor de Texto, Terminal (Ptyxis), Firefox, VS Code, LibreOffice e um app Qt abertos, a barra troca corretamente a cada foco, sem atraso perceptível.
- Nenhum erro no `journalctl` ao ativar, desativar e reativar a extensão 10 vezes seguidas.
- Bloquear tela e voltar não duplica a barra nem perde menus.
- Todos os textos visíveis estão em português do Brasil.
- O README explica com honestidade o que funciona em cada tipo de app.
