/*
  We follow the conventional commits specification to structure our commit messages.
  You can read more about it here: https://www.conventionalcommits.org/en/v1.0.0/.
  We use commitlint preset for conventional commits:
    https://github.com/conventional-changelog/commitlint/blob/master/%40commitlint/config-conventional/index.js
  Read commitlint docs if you need to extend the ruleset:
    https://commitlint.js.org/#/reference-rules
*/
export default {
  extends: [
    '@commitlint/config-conventional',
  ],
  rules: {
    "header-max-length": [2, "always", 100],
    "subject-case": [2, "always", ["sentence-case"]],
    "type-enum": [
      2,
      "always",
      [
        "chore",
        "ci",
        "docs",
        "feat",
        "fix",
        "gemfile",
        "migration",
        "perf",
        "refactor",
        "revert",
        "style",
        "test",
      ],
    ],
    "body-case": [2, "always", ["sentence-case"]],
  },
};
