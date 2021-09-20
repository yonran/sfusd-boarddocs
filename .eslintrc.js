// This file enables prettier and other js or ts rules.
// See src/.eslintrc.js for typescript-specific rules
module.exports = {
    // don't look in any more parent directories for other .eslintrc files
    // https://eslint.org/docs/user-guide/configuring/configuration-files#using-configuration-files
    root: true,
    // eslint-disable-next-line max-len
    // npm i -D eslint prettier eslint-config-prettier eslint-plugin-{jest,prettier,simple-import-sort} @typescript-eslint/{parser,eslint-plugin}

    extends: [
        // eslint-config-prettier:
        // disable eslint rules that conflict with prettier
        // such as max-len
        'prettier',
    ],
    plugins: [
        // eslint-plugin-prettier:
        // run prettier when the prettier/prettier rule is turned on
        'eslint-plugin-prettier',
    ],
    env: {
        //   "jest/globals": true,
        node: true,
    },
    globals: {
        // Workaround for error 'NodeJS' is not defined no-undef in @typescript-eslint/parser@4
        // https://github.com/Chatie/eslint-config/issues/45#issuecomment-885507652
        NodeJS: true,
    },
    parserOptions: {
        // enable optional chaining
        // also requires prettier 1.19.0 https://github.com/prettier/prettier/pull/6657
        // https://prettier.io/blog/2019/11/09/1.19.0.html
        ecmaVersion: 2020,
    },
    rules: {
        // note: import type requires prettier 2.0 so we have to upgrade to at least 2.0
        // https://github.com/prettier/prettier/commit/20c7a5ab9a6ff29d7622a4126d6dd215ece1ec35
        // https://prettier.io/blog/2020/03/21/2.0.0.html
        // 'max-len': [
        //     'error',
        //     {
        //         code: 110,
        //         ignoreStrings: true,
        //         ignoreUrls: true,
        //     },
        // ],
        'prettier/prettier': ['error', require('./.prettierrc')],
        'one-var': 'off',
        'spaced-comment': 'off',
        'no-useless-escape': 'off', // TODO should probably be on, with our errors fixed
        'prefer-promise-reject-errors': 'off', // TODO consider fixing
        'no-unneeded-ternary': 'off', // TODO should probably be on, with our errors fixed
        'no-useless-return': 'off',
        'new-cap': 'off',
        'no-path-concat': 'off',
        'no-throw-literal': 'off', // TODO should probably be on, with our errors fixed
        'no-template-curly-in-string': 'off',
        yoda: 'off',
    },
};
