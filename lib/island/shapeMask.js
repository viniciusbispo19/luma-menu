// SPDX-License-Identifier: GPL-3.0-or-later
// Máscara em GLSL: recorta o desfoque da forma do Isle no formato dela
// (corpo com cantos arredondados embaixo + ombros côncavos).
//
// Por que um shader? O desfoque é um retângulo. Para ele acompanhar os
// cantos e os ombros (curvas que o CSS não faz), cada pixel calcula se está
// DENTRO da forma e multiplica a cor pela "cobertura" (0 = fora, 1 = dentro,
// valores intermediários na borda = antisserrilhado).
//
// Como funciona um Clutter.ShaderEffect: o Clutter desenha o ator (e os
// filhos) numa textura fora da tela e depois a desenha na tela passando
// cada pixel pelo nosso código. As "uniforms" são os números que mandamos
// do JavaScript para o shader (tamanho, cantos, ombros) a cada quadro.
//
// Coordenadas: y = 0 é a borda de BAIXO da barra (onde os ombros nascem).

import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform float lm_width;
uniform float lm_height;
uniform float lm_left;
uniform float lm_right;
uniform float lm_shoulder;
uniform float lm_corner;

// Quanto do pixel está dentro do círculo (0 a 1, com 1 px de suavização).
float lm_in_circle(vec2 p, vec2 center, float radius) {
    return clamp(radius - distance(p, center) + 0.5, 0.0, 1.0);
}
`;

// Roda DEPOIS da cor normal do pixel (cogl_color_out) ser calculada.
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * vec2(lm_width, lm_height);
float cover = 0.0;

// Corpo: retângulo com os dois cantos de baixo arredondados.
if (p.x >= lm_left && p.x <= lm_right) {
    cover = 1.0;
    float r = lm_corner;
    if (r > 0.0 && p.y > lm_height - r) {
        if (p.x < lm_left + r)
            cover = lm_in_circle(p, vec2(lm_left + r, lm_height - r), r);
        else if (p.x > lm_right - r)
            cover = lm_in_circle(p, vec2(lm_right - r, lm_height - r), r);
    }
}

// Ombros: o que fica FORA do círculo, no cantinho junto à barra.
float s = lm_shoulder;
if (s > 0.5 && p.y <= s) {
    if (p.x < lm_left && p.x >= lm_left - s)
        cover = max(cover, 1.0 - lm_in_circle(p, vec2(lm_left - s, s), s));
    else if (p.x > lm_right && p.x <= lm_right + s)
        cover = max(cover, 1.0 - lm_in_circle(p, vec2(lm_right + s, s), s));
}

// As cores do Clutter têm alfa pré-multiplicado: multiplicar tudo apaga.
cogl_color_out *= cover;
`;

export const ShapeMask = GObject.registerClass(
class LumaMenuIslandShapeMask extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
    }

    /**
     * @param {object} shape - medidas em px lógicos
     * @param {number} shape.width - largura da área desfocada
     * @param {number} shape.height - altura abaixo da barra
     * @param {number} shape.left - x onde começa o corpo
     * @param {number} shape.right - x onde termina o corpo
     * @param {number} shape.shoulder - raio dos ombros
     * @param {number} shape.corner - raio dos cantos de baixo
     */
    setShape({width, height, left, right, shoulder, corner}) {
        this.set_uniform_float('lm_width', 1, [width]);
        this.set_uniform_float('lm_height', 1, [height]);
        this.set_uniform_float('lm_left', 1, [left]);
        this.set_uniform_float('lm_right', 1, [right]);
        this.set_uniform_float('lm_shoulder', 1, [shoulder]);
        this.set_uniform_float('lm_corner', 1, [corner]);
    }
});
