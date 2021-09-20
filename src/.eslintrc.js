module.exports = {
    extends: ['../.eslintrc.js'],
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint', 'simple-import-sort', 'jest'],
    parserOptions: {
        // parserOptions.project is required for rules that require parserServices
        // e.g. @typescript-eslint/no-floating-promises
        project: ['./tsconfig.json'],
    },
    rules: {
        'simple-import-sort/imports': 'error',
        'simple-import-sort/exports': 'error',
        // note: import type requires prettier 2.0 so we have to upgrade to at least 2.0
        // https://github.com/prettier/prettier/commit/20c7a5ab9a6ff29d7622a4126d6dd215ece1ec35
        // https://prettier.io/blog/2020/03/21/2.0.0.html
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
    },
};
