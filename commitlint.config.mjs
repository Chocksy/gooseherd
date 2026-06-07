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
  // Dependabot writes lowercase subjects (e.g. "bump axios ...") that violate our
  // sentence-case rule. Its commits are machine-generated and not authored by us,
  // so skip linting them rather than weakening the rule for human commits.
  ignores: [
    (message) => /Signed-off-by: dependabot\[bot\]/.test(message),
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
