// SPDX-License-Identifier: GPL-3.0-or-later
// Infraestrutura de menus do Luma Menu: menus suspensos no estilo do macOS,
// com atalho alinhado à direita, marca ✓, seta › e SUBMENUS EM CASCATA.
//
// Por que não usar só o PopupMenu do GNOME? Os submenus do GNOME
// (PopupSubMenuMenuItem) são "sanfona": abrem para baixo, dentro do próprio
// menu. No macOS o submenu abre AO LADO. Para isso:
//
//  1. Cada menu de título (LumaMenu) ganha um ator "raiz" de tamanho zero
//     (MenuRoot). O menu principal e todos os submenus em cascata são filhos
//     dessa raiz.
//  2. O gerenciador de menus do painel faz um "grab" (captura de eventos) no
//     `menu.actor`. Como trocamos `menu.actor` pela raiz, os submenus ficam
//     DENTRO do grab e recebem cliques e teclado normalmente.
//  3. A raiz tem tamanho zero, então nunca "tampa" o painel: passar o mouse
//     em outro título continua trocando de menu.
//
// Além disso, os menus são construídos a partir de um MODELO simples (lista
// de objetos JS). Todas as fontes de menu (padrão, GTK, DBusMenu) produzem
// esse mesmo modelo, e a busca do menu Ajuda também o percorre.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {IslandSurface} from './island/surface.js';
import {formatAccelerator} from './shortcuts.js';
import {TimeoutRegistry, logError} from './util.js';

const OPEN_ANIMATION_TIME = 120; // ms (spec: ~120 ms)
const OPEN_ANIMATION_OFFSET = 6; // px de deslocamento na abertura
const CASCADE_OPEN_DELAY = 80; // ms parado sobre o item até abrir o submenu
const CASCADE_CLOSE_DELAY = 300; // ms de tolerância para o mouse "atravessar" itens

// Visual do Isle nos menus: a forma que sai da barra tem cantos um pouco
// maiores que os do menu e ombros menores que os do painel do relógio.
const ISLAND_CORNER_EXTRA = 6; // px somados ao "arredondamento dos menus"
const ISLAND_SHOULDER = 10; // px
const ISLAND_FADE_TIME = 150; // ms (o conteúdo aparece enquanto a forma cresce)
const ISLAND_FADE_DELAY = 40; // ms

/** Raiz de tamanho zero que segura o menu e os submenus em cascata. */
const MenuRoot = GObject.registerClass(
class LumaMenuRoot extends St.Widget {
    _init() {
        // reactive: precisa receber os eventos redirecionados pelo grab.
        super._init({reactive: true});
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        // Cada BoxPointer calcula a própria posição na tela em _reposition();
        // aqui só damos a ele o tamanho que ele pediu.
        for (const child of this.get_children()) {
            if (child.visible)
                child.allocate_preferred_size(0, 0);
        }
    }
});

/**
 * Código comum a LumaMenu e CascadeMenu: no máximo um submenu aberto por vez.
 *
 * @param {PopupMenu.PopupMenu} menu
 * @param {CascadeMenu|null} child
 */
function setOpenChild(menu, child) {
    if (menu._openChild && menu._openChild !== child)
        menu._openChild.close({animate: false});
    menu._openChild = child;
}

/** Aplica o estilo comum (classes CSS) a um PopupMenu nosso. */
function styleMenu(menu) {
    menu._boxPointer.add_style_class_name('luma-menu-boxpointer');
    menu.box.add_style_class_name('luma-menu-content');
}

/**
 * Menu principal de um título da barra (Arquivo, Editar…).
 */
export class LumaMenu extends PopupMenu.PopupMenu {
    /**
     * @param {Clutter.Actor} sourceActor - o botão do título
     * @param {object} appearance - {opacity: 0–1, radius: px}
     * @param {number} [alignment] - 0 = alinha pela esquerda do título (menus
     *   da barra); 1 = pela direita (o painel do relógio, no canto direito)
     */
    constructor(sourceActor, appearance = {}, alignment = 0.0) {
        super(sourceActor, alignment, St.Side.TOP);
        styleMenu(this);
        this._appearance = appearance;
        this._openChild = null;
        this._surface = null; // forma do Isle atrás do menu (criada sob demanda)

        // Com o visual do Isle, quem desenha e desfoca o fundo é a nossa forma.
        // O Blur my Shell desfoca todo menu cuja caixa tem a classe
        // "popup-menu-content" e desenharia o vidro dele POR CIMA da forma
        // (halo nos cantos). Sem a classe, ele deixa o menu principal para nós
        // — e continua desfocando os submenus em cascata, que ficam com ela.
        // Ele decide quando o menu entra no palco, por isso isto é feito aqui
        // no construtor (ligar/desligar a opção recria a barra).
        if (appearance.look?.menusEnabled)
            this.box.remove_style_class_name('popup-menu-content');

        // Troca o ator do menu pela raiz (veja o comentário no topo).
        this._root = new MenuRoot();
        this._root._delegate = this;
        this._root.add_child(this._boxPointer);
        this.actor = this._root;
    }

    /** O BoxPointer visível do menu principal. */
    get boxPointer() {
        return this._boxPointer;
    }

    /** @param {object} appearance - {opacity, radius} */
    setAppearance(appearance) {
        this._appearance = appearance;
        if (this.isOpen)
            this._applyAppearance(this.box);
    }

    /** Coloca o ator de um submenu dentro da raiz (dentro do grab). */
    _addCascadeActor(actor) {
        this._root.add_child(actor);
    }

    _setOpenChild(child) {
        setOpenChild(this, child);
    }

    /** Os menus usam o visual do Isle (preferência "island-menus")? */
    get _islandLook() {
        return Boolean(this._appearance.look?.menusEnabled);
    }

    /**
     * Aplica opacidade e arredondamento configuráveis, preservando a cor de
     * fundo do tema (clara ou escura) — lemos a cor que o tema definiu e só
     * trocamos o canal alfa.
     *
     * Com o visual do Isle, o fundo do menu principal fica transparente: quem
     * desenha o fundo é a forma (vidro fumê) atrás dele. Os submenus em
     * cascata flutuam ao lado, sem forma: ganham a cor da barra direto.
     *
     * @param {St.Widget} box
     * @param {boolean} [cascade] - é o fundo de um submenu
     */
    _applyAppearance(box, cascade = false) {
        const {opacity = 0.92, radius = 10, look = null} = this._appearance;
        // Blur my Shell desfocando este menu: ele mesmo pinta o vidro (classe
        // no tema dele) e escreve no estilo da caixa um border-radius igual ao
        // do desfoque. Não mexemos em nada — senão apagaríamos o raio dele e
        // cobriríamos o vidro com o nosso fundo opaco.
        if (!this._islandLook && box.has_style_class_name('bms-popup-blurred'))
            return;
        box.style = null;
        if (this._islandLook) {
            if (!cascade) {
                box.style = 'background-color: transparent; border-color: transparent; box-shadow: none;';
                return;
            }
            const [tr, tg, tb, ta] = look.tint;
            // Submenu: o Blur my Shell desfoca por trás (quando instalado), mas
            // sem ele o fundo precisa ser quase opaco para ler.
            if (ta >= 0.6) {
                box.style = `background-color: rgba(${tr}, ${tg}, ${tb}, ${Math.max(ta, 0.9)}); ` +
                    `border-radius: ${radius + ISLAND_CORNER_EXTRA}px;`;
                return;
            }
        }
        const color = box.get_theme_node().get_background_color();
        const [r, g, b] = color.alpha > 0
            ? [color.red, color.green, color.blue]
            : [36, 36, 38];
        box.style = `background-color: rgba(${r}, ${g}, ${b}, ${opacity}); ` +
            `border-radius: ${radius}px;`;
    }

    open(params = {}) {
        const animate = params.animate ?? true;
        // Título ainda sem posição na tela (a barra acabou de ser criada): o
        // BoxPointer do GNOME calcularia a posição do menu com NaN.
        if (!this.sourceActor?.has_allocation())
            return false;
        // Gancho para o dono do menu reconstruir o conteúdo antes de abrir
        // (ex.: "Entrar em Tela Cheia" vira "Sair da Tela Cheia").
        if (!this.isOpen)
            this.beforeOpen?.();

        // Abrimos sem a animação padrão do GNOME e fazemos a nossa:
        // fade + leve deslizada para baixo (~120 ms), como no macOS.
        if (!super.open({...params, animate: false}))
            return false;

        this._applyAppearance(this.box);
        // Gancho pós-abertura (ex.: pôr o foco no campo de busca do Ajuda).
        this.afterOpen?.();

        this._boxPointer.remove_style_class_name('luma-menu-island-look');
        if (this._islandLook) {
            this._openSurface();
        } else if (animate && !params.fadeOnly) {
            // Trocar de menu passando o mouse (fadeOnly) deve ser instantâneo.
            const bp = this._boxPointer;
            bp.remove_all_transitions();
            bp.opacity = 0;
            bp.translation_y = -OPEN_ANIMATION_OFFSET;
            // actor.ease() respeita "Reduzir animação": a duração vira 0.
            bp.ease({
                opacity: 255,
                translation_y: 0,
                duration: OPEN_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        return true;
    }

    close(params) {
        setOpenChild(this, null);
        const changed = super.close(params);
        // A forma volta para dentro do título (o conteúdo some com ela).
        this._surface?.close();
        return changed;
    }

    destroy() {
        this._destroySurface();
        super.destroy();
    }

    _destroySurface() {
        if (!this._surface)
            return;
        const surface = this._surface;
        this._surface = null;
        surface.stopAnimations();
        surface.destroy();
    }

    // ----- Visual do Isle -----------------------------------------------------------

    /**
     * A forma de vidro fumê nasce do título na barra e cresce até o tamanho
     * do menu. O conteúdo do menu é RECORTADO pelo corpo da forma a cada
     * quadro: ele vai aparecendo conforme ela cresce (e some ao fechar).
     */
    _openSurface() {
        const bp = this._boxPointer;
        bp.add_style_class_name('luma-menu-island-look');
        bp.translation_y = 0;

        if (!this._surface) {
            this._surface = new IslandSurface({
                corner: (this._appearance.radius ?? 10) + ISLAND_CORNER_EXTRA,
                shoulder: ISLAND_SHOULDER,
            });
            // Logo abaixo da raiz do menu: por cima da barra, por baixo do menu.
            Main.layoutManager.uiGroup.insert_child_below(this._surface, this.actor);
            this._surface.connect('frame', () => this._clipToSurface());
            this._surface.connect('settled', () => {
                // Aberta e parada: sem recorte (o menu pode mudar de tamanho).
                if (this._surface.isOpen)
                    bp.remove_clip();
            });
            // Fechou: some com a forma (e com o fundo desfocado dela). Na
            // próxima abertura ela é criada de novo — memória só em uso.
            this._surface.connect('closed', () => {
                bp.remove_clip();
                this._destroySurface();
            });
            // O menu mudou de tamanho (itens reconstruídos): a forma acompanha.
            if (!this._boxWatched) {
                this._boxWatched = true;
                this.box.connect('notify::allocation', () => this._surface?.scheduleRetarget());
            }
        }

        const surface = this._surface;
        const index = Math.max(0, Main.layoutManager.findIndexForActor(this.sourceActor));
        this._surfaceMonitor = Main.layoutManager.monitors[index];
        surface.setGeometry(this._surfaceMonitor, index, Math.max(Main.panel.height, 24));
        surface.setTint(this._appearance.look.tint);
        const [sx] = this.sourceActor.get_transformed_position();
        const [sw] = this.sourceActor.get_transformed_size();
        surface.setAnchor(Math.round(sx), Math.round(sw));
        surface.open(() => this._surfaceTarget());

        bp.remove_all_transitions();
        bp.opacity = 0;
        bp.ease({
            opacity: 255,
            delay: ISLAND_FADE_DELAY,
            duration: ISLAND_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Corpo aberto = a caixa do menu, do topo da tela até embaixo dela. */
    _surfaceTarget() {
        const [x, y] = this.box.get_transformed_position();
        const [w, h] = this.box.get_transformed_size();
        if (!w || !h || !this._surfaceMonitor)
            return null;
        return {x, width: w, height: y + h - this._surfaceMonitor.y};
    }

    _clipToSurface() {
        const rect = this._surface?.bodyRect;
        if (!rect)
            return;
        const [bx, by] = this._boxPointer.get_transformed_position();
        if (![bx, by, rect.x, rect.width, rect.height].every(Number.isFinite))
            return;
        this._boxPointer.set_clip(rect.x - bx, rect.y - by, rect.width, rect.height);
    }
}

/**
 * Submenu que abre ao lado do item (cascata).
 */
export class CascadeMenu extends PopupMenu.PopupMenu {
    /**
     * @param {SubmenuItem} item - o item com a seta ›
     * @param {LumaMenu|CascadeMenu} parentMenu - menu que contém o item
     */
    constructor(item, parentMenu) {
        // St.Side.LEFT: a "seta" fica à esquerda, logo o menu abre à DIREITA.
        // Se não couber na tela, o BoxPointer inverte o lado sozinho.
        super(item, 0.0, St.Side.LEFT);
        styleMenu(this);
        this._boxPointer.add_style_class_name('luma-menu-cascade');
        // Alinha o topo do submenu com o topo do item (como no macOS).
        this._boxPointer.setSourceAlignment(0.0);

        this._item = item;
        this._parentMenu = parentMenu;
        this._openChild = null;
        // Faz _getTopMenu() devolver o menu principal: ativar um item aqui
        // dentro fecha a árvore inteira.
        this._setParent(parentMenu);

        // Seta ← dentro do submenu volta para o item que o abriu.
        this._leftKey = new Clutter.KeyController();
        this._leftKey.connect('key-press', () => {
            const [, symbol] = this._leftKey.get_key();
            if (symbol !== Clutter.KEY_Left)
                return Clutter.EVENT_PROPAGATE;
            this.close({animate: false});
            this._item.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        this._boxPointer.add_action(this._leftKey);

        parentMenu._getTopMenu()._addCascadeActor(this.actor);
        this.actor.hide();
    }

    _setOpenChild(child) {
        setOpenChild(this, child);
    }

    _addCascadeActor(actor) {
        this._getTopMenu()._addCascadeActor(actor);
    }

    open(params = {}) {
        this._parentMenu._setOpenChild(this);
        if (!super.open({...params, animate: false}))
            return false;
        this._getTopMenu()._applyAppearance?.(this.box, true);
        this._item.add_style_pseudo_class('checked');
        return true;
    }

    close(params) {
        setOpenChild(this, null);
        this._item.remove_style_pseudo_class('checked');
        if (this._parentMenu._openChild === this)
            this._parentMenu._openChild = null;
        return super.close(params);
    }

    /** O ponteiro do mouse está sobre este submenu (ou um filho dele)? */
    containsPointer() {
        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (this.actor.contains(actor))
            return true;
        return this._openChild?.containsPointer() ?? false;
    }
}

/**
 * Item de menu: [✓] [ícone] Rótulo ............ Atalho
 */
export const MenuItem = GObject.registerClass(
class LumaMenuItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {object} params
     * @param {string} params.label
     * @param {string} [params.accelText] - atalho já formatado ("Ctrl+C")
     * @param {boolean|null} [params.checked] - true = ✓; null = não marcável
     * @param {Gio.Icon} [params.icon]
     * @param {boolean} [params.arrow] - mostra › (itens com submenu)
     * @param {boolean} [params.activatable] - false = texto informativo
     */
    _init(params = {}) {
        const {label = '', accelText = '', checked = null, icon = null,
            arrow = false, activatable = true} = params;
        super._init({
            style_class: 'luma-menu-item',
            activate: activatable,
            reactive: activatable,
            can_focus: activatable,
        });

        // Coluna do ✓ sempre ocupa espaço, para os rótulos ficarem alinhados.
        this._check = new St.Label({
            style_class: 'luma-menu-check',
            text: checked ? '✓' : '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._check);
        if (checked)
            this.add_accessible_state(Atk.StateType.CHECKED);

        if (icon) {
            this.add_child(new St.Icon({
                gicon: icon,
                style_class: 'luma-menu-item-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this.label = new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;

        const sideText = arrow ? '›' : accelText;
        if (sideText) {
            this._side = new St.Label({
                style_class: arrow ? 'luma-menu-arrow' : 'luma-menu-accel',
                text: sideText,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._side);
        }
    }
});

/**
 * Item com submenu em cascata (seta ›).
 */
export const SubmenuItem = GObject.registerClass(
class LumaSubmenuItem extends MenuItem {
    /**
     * @param {object} params - os mesmos de MenuItem
     * @param {Function} populate - (cascadeMenu) => void; preenche o submenu
     */
    _init(params, populate) {
        super._init({...params, arrow: true});
        this._populate = populate;
        this._cascade = null;
        this._timers = new TimeoutRegistry();
        this._openTimer = 0;
        this._closeTimer = 0;
        this.accessible_role = Atk.Role.MENU;

        // Parar o mouse sobre o item abre o submenu (sem clicar).
        this.connect('notify::hover', () => {
            this._timers.remove(this._openTimer);
            if (this.hover && this.sensitive) {
                this._openTimer = this._timers.add(CASCADE_OPEN_DELAY,
                    () => this.openCascade(false));
            }
        });
        this.connect('destroy', () => {
            this._timers.clear();
            this._cascade?.destroy();
            this._cascade = null;
        });
    }

    _setParent(parent) {
        super._setParent(parent);
        // Quando OUTRO item do mesmo menu fica ativo, fechamos o submenu —
        // com uma pequena tolerância, para o usuário poder levar o mouse em
        // diagonal até o submenu passando por cima de outros itens.
        parent.connectObject('active-changed', (_menu, activeItem) => {
            if (!activeItem || activeItem === this || !this._cascade?.isOpen)
                return;
            this._timers.remove(this._closeTimer);
            this._closeTimer = this._timers.add(CASCADE_CLOSE_DELAY, () => {
                if (this._cascade?.isOpen && !this.hover && !this._cascade.containsPointer())
                    this._cascade.close({animate: false});
            });
        }, this);
    }

    /**
     * @param {boolean} focusFirst - foca o primeiro item (uso pelo teclado)
     */
    openCascade(focusFirst) {
        if (!this._parent || !this.sensitive)
            return;
        this._cascade ??= new CascadeMenu(this, this._parent);
        if (!this._cascade.isOpen) {
            this._cascade.removeAll();
            try {
                this._populate(this._cascade);
            } catch (e) {
                logError(e, 'preenchendo submenu');
            }
            this._cascade.open({animate: false});
        }
        if (focusFirst)
            this._cascade.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    // Clique ou Enter no item: abre o submenu em vez de "ativar" (o que
    // fecharia o menu inteiro).
    activate(event) {
        const type = event?.type();
        const fromKeyboard = type === Clutter.EventType.KEY_PRESS ||
            type === Clutter.EventType.KEY_RELEASE;
        this.openCascade(fromKeyboard);
    }
});

// --------------------------------------------------------------------------
// Construção a partir de modelo
// --------------------------------------------------------------------------
//
// Um modelo de menu é uma lista de "nós" (objetos simples):
//
//   {separator: true}
//   {header: 'Aplicativos'}                       // título cinza, não clicável
//   {label: 'Copiar', accel: '<Control>c',        // item comum
//    sensitive: true, checked: null, icon: gicon,
//    activate: () => {...}}
//   {label: 'Buscar', children: [...]}            // submenu (lista, função
//                                                 //   ou função assíncrona)
//   {custom: menu => item}                        // widget especial
//   {..., visible: false}                         // ignorado
//
// Um item sem `activate` (ou com sensitive: false) aparece em cinza.

/**
 * Preenche `menu` com os nós do modelo.
 *
 * @param {PopupMenu.PopupMenuBase} menu
 * @param {object[]} nodes
 * @param {object} options - {shortcutStyle}
 */
export function fillMenu(menu, nodes, options = {}) {
    for (const node of nodes ?? []) {
        if (!node || node.visible === false)
            continue;
        try {
            addNode(menu, node, options);
        } catch (e) {
            logError(e, `criando item "${node.label ?? ''}"`);
        }
    }
}

function addNode(menu, node, options) {
    if (node.separator) {
        const sep = new PopupMenu.PopupSeparatorMenuItem();
        sep.add_style_class_name('luma-menu-separator');
        menu.addMenuItem(sep);
        return;
    }

    if (node.header !== undefined) {
        const header = new MenuItem({label: node.header, activatable: false});
        header.add_style_class_name('luma-menu-header');
        menu.addMenuItem(header);
        return;
    }

    if (node.custom) {
        const item = node.custom(menu);
        if (item)
            menu.addMenuItem(item);
        return;
    }

    if (node.children !== undefined) {
        const item = new SubmenuItem({label: node.label, icon: node.icon},
            cascade => populateChildren(cascade, node.children, options));
        menu.addMenuItem(item);
        item.setSensitive(node.sensitive !== false);
        return;
    }

    const item = new MenuItem({
        label: node.label,
        accelText: formatAccelerator(node.accel, options.shortcutStyle),
        checked: node.checked ?? null,
        icon: node.icon ?? null,
    });
    menu.addMenuItem(item);
    item.setSensitive(node.sensitive !== false && typeof node.activate === 'function');

    // connect_after + depois do addMenuItem: nosso handler roda DEPOIS do
    // handler do menu, que fecha o menu e solta o grab. Assim a ação (ex.:
    // simular Ctrl+C) já encontra o foco de volta na janela do app.
    item.connect_after('activate', () => {
        try {
            node.activate();
        } catch (e) {
            logError(e, `executando "${node.label}"`);
        }
    });
}

/**
 * Filhos de submenu podem ser uma lista, uma função ou uma função assíncrona
 * (ex.: documentos recentes lidos do disco, menus D-Bus carregados sob demanda).
 */
function populateChildren(cascade, children, options) {
    const result = typeof children === 'function' ? children() : children;
    if (!(result instanceof Promise)) {
        fillMenu(cascade, result, options);
        return;
    }

    // Enquanto carrega, mostra "…" (o menu não pode abrir vazio).
    fillMenu(cascade, [{label: '…', sensitive: false}], options);
    result.then(nodes => {
        if (!cascade.isOpen)
            return;
        cascade.removeAll();
        fillMenu(cascade, nodes?.length ? nodes : [{label: '—', sensitive: false}], options);
    }).catch(e => logError(e, 'carregando submenu'));
}
