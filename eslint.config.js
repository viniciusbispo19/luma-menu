// Configuração do ESLint (formato "flat config", ESLint 9+).
//
// As regras de estilo seguem as do próprio GNOME Shell (indentação de 4
// espaços, aspas simples, vírgula no final de listas multilinha, etc.).
// Assim o código fica parecido com o do Shell, e os revisores do
// extensions.gnome.org leem com mais facilidade.

import js from '@eslint/js';

// Variáveis globais que existem no GJS / GNOME Shell, mas não num navegador
// nem no Node. Sem isso o ESLint acusaria "global is not defined".
const gjsGlobals = {
    global: 'readonly', // o objeto Shell.Global (global.display, global.stage…)
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    ARGV: 'readonly',
};

export default [
    {
        ignores: ['node_modules/', 'build/'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            // --- Erros prováveis ---
            'eqeqeq': ['error', 'always', {null: 'ignore'}],
            'no-unused-vars': ['error', {
                // Convenção do GNOME: prefixo "_" = parâmetro ignorado de propósito.
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
            'prefer-const': 'error',
            'no-var': 'error',

            // --- Estilo do GNOME Shell ---
            'indent': ['error', 4, {
                ignoredNodes: [
                    'CallExpression > ArrowFunctionExpression',
                    // Convenção do GNOME: em `GObject.registerClass(\nclass X …`
                    // a classe fica na coluna 0, sem indentação extra.
                    'CallExpression[callee.object.name=GObject][callee.property.name=registerClass] > ClassExpression:first-child',
                ],
                CallExpression: {arguments: 'first'},
                MemberExpression: 'off',
                SwitchCase: 1,
            }],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
            'object-curly-spacing': ['error', 'never'],
            'array-bracket-spacing': ['error', 'never'],
            'arrow-parens': ['error', 'as-needed'],
            'brace-style': ['error', '1tbs', {allowSingleLine: true}],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'keyword-spacing': 'error',
            'space-before-blocks': 'error',
            'space-before-function-paren': ['error', {
                anonymous: 'never', named: 'never', asyncArrow: 'always',
            }],
            'no-trailing-spaces': 'error',
            'eol-last': 'error',
            'prefer-arrow-callback': 'error',
            'prefer-template': 'error',
            'max-len': ['error', 110, {
                ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true,
            }],
        },
    },
];
