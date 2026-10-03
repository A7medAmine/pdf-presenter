"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "public/vendor/", "uploads/", "coverage/"] },
  js.configs.recommended,
  {
    files: ["server.js", "src/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: globals.node },
  },
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, io: "readonly", pdfjsLib: "readonly", QRious: "readonly" },
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: globals.serviceworker },
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      curly: ["error", "multi-line"],
    },
  },
];
