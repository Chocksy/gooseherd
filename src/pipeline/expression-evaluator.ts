/**
 * Safe expression evaluator for pipeline node `if` conditions.
 * Recursive-descent parser — NO eval().
 *
 * Supports:
 *   - Equality: ==, !=
 *   - Comparison: >, <, >=, <=
 *   - Boolean: &&, ||, !
 *   - String ops: contains, matches
 *   - Literals: strings ('...'), numbers, true/false
 *   - Variable references: ctx.repoDir, config.lintFixCommand
 */

type TokenType =
  | "STRING" | "NUMBER" | "BOOL" | "IDENTIFIER"
  | "EQ" | "NEQ" | "GT" | "LT" | "GTE" | "LTE"
  | "AND" | "OR" | "NOT"
  | "CONTAINS" | "MATCHES"
  | "LPAREN" | "RPAREN"
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const src = expression;

  while (i < src.length) {
    // Skip whitespace
    if (src[i] === " " || src[i] === "\t") {
      i++;
      continue;
    }

    // String literals (single or double quoted)
    if (src[i] === "'" || src[i] === '"') {
      const quote = src[i];
      const startPos = i;
      i++;
      let value = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          i++;
          value += src[i];
        } else {
          value += src[i];
        }
        i++;
      }
      if (i >= src.length) {
        throw new Error(`Unterminated string literal starting at position ${String(startPos)} in expression: ${expression}`);
      }
      i++; // skip closing quote
      tokens.push({ type: "STRING", value });
      continue;
    }

    // Two-char operators
    if (i + 1 < src.length) {
      const two = src[i]! + src[i + 1]!;
      if (two === "==") { tokens.push({ type: "EQ", value: "==" }); i += 2; continue; }
      if (two === "!=") { tokens.push({ type: "NEQ", value: "!=" }); i += 2; continue; }
      if (two === ">=") { tokens.push({ type: "GTE", value: ">=" }); i += 2; continue; }
      if (two === "<=") { tokens.push({ type: "LTE", value: "<=" }); i += 2; continue; }
      if (two === "&&") { tokens.push({ type: "AND", value: "&&" }); i += 2; continue; }
      if (two === "||") { tokens.push({ type: "OR", value: "||" }); i += 2; continue; }
    }

    // Single-char operators
    if (src[i] === ">") { tokens.push({ type: "GT", value: ">" }); i++; continue; }
    if (src[i] === "<") { tokens.push({ type: "LT", value: "<" }); i++; continue; }
    if (src[i] === "!") { tokens.push({ type: "NOT", value: "!" }); i++; continue; }
    if (src[i] === "(") { tokens.push({ type: "LPAREN", value: "(" }); i++; continue; }
    if (src[i] === ")") { tokens.push({ type: "RPAREN", value: ")" }); i++; continue; }

    // Numbers
    if (/[0-9]/.test(src[i]!)) {
      let value = "";
      while (i < src.length && /[0-9.]/.test(src[i]!)) {
        value += src[i];
        i++;
      }
      tokens.push({ type: "NUMBER", value });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(src[i]!)) {
      let value = "";
      while (i < src.length && /[a-zA-Z0-9_.]/.test(src[i]!)) {
        value += src[i];
        i++;
      }
      if (value === "true" || value === "false") {
        tokens.push({ type: "BOOL", value });
      } else if (value === "contains") {
        tokens.push({ type: "CONTAINS", value });
      } else if (value === "matches") {
        tokens.push({ type: "MATCHES", value });
      } else {
        tokens.push({ type: "IDENTIFIER", value });
      }
      continue;
    }

    throw new Error(`Unexpected character '${src[i]}' at position ${String(i)} in expression: ${expression}`);
  }

  tokens.push({ type: "EOF", value: "" });
  return tokens;
}

type ResolveVar = (name: string) => unknown;

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private resolveVar: ResolveVar
  ) {}

  parse(): boolean {
    const result = this.parseOr();
    if (this.current().type !== "EOF") {
      throw new Error(`Unexpected token: ${this.current().value}`);
    }
    return result;
  }

  private current(): Token {
    return this.tokens[this.pos] ?? { type: "EOF", value: "" };
  }

  private advance(): Token {
    const token = this.current();
    this.pos++;
    return token;
  }

  private parseOr(): boolean {
    let left = this.parseAnd();
    while (this.current().type === "OR") {
      this.advance();
      if (left) {
        // Short-circuit: skip right-hand side parsing but still consume tokens
        this.parseAnd();
      } else {
        left = this.parseAnd();
      }
    }
    return left;
  }

  private parseAnd(): boolean {
    let left = this.parseNot();
    while (this.current().type === "AND") {
      this.advance();
      if (!left) {
        // Short-circuit: skip right-hand side evaluation but still consume tokens
        this.parseNot();
      } else {
        left = this.parseNot();
      }
    }
    return left;
  }

  private parseNot(): boolean {
    if (this.current().type === "NOT") {
      this.advance();
      return !this.parseNot();
    }
    return this.parseComparison();
  }

  private parseComparison(): boolean {
    const left = this.parseValue();

    const op = this.current().type;
    if (op === "EQ") { this.advance(); return left === this.parseValue(); }
    if (op === "NEQ") { this.advance(); return left !== this.parseValue(); }
    if (op === "GT") { this.advance(); return Number(left) > Number(this.parseValue()); }
    if (op === "LT") { this.advance(); return Number(left) < Number(this.parseValue()); }
    if (op === "GTE") { this.advance(); return Number(left) >= Number(this.parseValue()); }
    if (op === "LTE") { this.advance(); return Number(left) <= Number(this.parseValue()); }

    if (op === "CONTAINS") {
      this.advance();
      const right = this.parseValue();
      return String(left).includes(String(right));
    }

    if (op === "MATCHES") {
      this.advance();
      const pattern = String(this.parseValue());
      const text = String(left);
      // Convert glob-like pattern to regex: ** → .*, * → [^/]*, ? → .
      // First escape regex metacharacters (except glob operators *, ?, ,)
      const regexStr = pattern
        .replace(/\*\*/g, "⊛")
        .replace(/\*/g, "⊚")
        .replace(/\?/g, "⊙")
        .replace(/,/g, "⊘")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/⊛/g, ".*")
        .replace(/⊚/g, "[^/]*")
        .replace(/⊙/g, ".")
        .replace(/⊘/g, "|");
      return new RegExp(`^(?:${regexStr})$`).test(text);
    }

    // Boolean coercion for standalone values
    return toBool(left);
  }

  private parseValue(): unknown {
    const token = this.current();

    if (token.type === "LPAREN") {
      this.advance();
      const result = this.parseOr();
      if (this.current().type !== "RPAREN") {
        throw new Error("Expected closing parenthesis");
      }
      this.advance();
      return result;
    }

    if (token.type === "STRING") {
      this.advance();
      return token.value;
    }

    if (token.type === "NUMBER") {
      this.advance();
      return Number(token.value);
    }

    if (token.type === "BOOL") {
      this.advance();
      return token.value === "true";
    }

    if (token.type === "IDENTIFIER") {
      this.advance();
      return this.resolveVar(token.value);
    }

    throw new Error(`Unexpected token: ${token.type} (${token.value})`);
  }
}

function toBool(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === 0 || value === false) {
    return false;
  }
  return true;
}

/**
 * Evaluate an expression string against a variable resolver.
 *
 * @param expression - The condition string, e.g. "config.lintFixCommand != ''"
 * @param resolveVar - Function that resolves dotted variable names to values
 * @returns boolean result
 */
export function evaluateExpression(expression: string, resolveVar: ResolveVar): boolean {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, resolveVar);
  return parser.parse();
}
