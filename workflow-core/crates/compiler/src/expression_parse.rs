use super::*;
use workflow_model::SourceSpan;

#[derive(Clone, Debug, PartialEq)]
enum TokenKind {
    Word(String),
    Integer(i64),
    Text(String),
    Symbol(char),
    Operator(&'static str),
}
#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    span: SourceSpan,
}
fn syntax(path: &str, detail: impl Into<String>, span: SourceSpan) -> CompileError {
    CompileError::new(CheckKind::Name, path, span, detail)
}
fn tokenize(source: &str, path: &str) -> Result<Vec<Token>, CompileError> {
    let mut tokens = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let ch = source[offset..].chars().next().unwrap();
        if ch.is_whitespace() {
            offset += ch.len_utf8();
            continue;
        }
        let start = offset;
        let kind = if ch == '"' {
            offset += 1;
            let mut escaped = false;
            let mut closed = false;
            while offset < source.len() {
                let next = source[offset..].chars().next().unwrap();
                offset += next.len_utf8();
                if escaped {
                    escaped = false;
                } else if next == '\\' {
                    escaped = true;
                } else if next == '"' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(syntax(
                    path,
                    "unterminated string literal",
                    SourceSpan { start, end: offset },
                ));
            }
            let literal = serde_json::from_str(&source[start..offset]).map_err(|error| {
                syntax(
                    path,
                    format!("malformed text literal: {error}"),
                    SourceSpan { start, end: offset },
                )
            })?;
            TokenKind::Text(literal)
        } else if ch.is_ascii_digit()
            || (matches!(ch, '+' | '-')
                && source
                    .as_bytes()
                    .get(offset + 1)
                    .is_some_and(u8::is_ascii_digit))
        {
            offset += 1;
            while offset < source.len() && source.as_bytes()[offset].is_ascii_digit() {
                offset += 1;
            }
            TokenKind::Integer(source[start..offset].parse().map_err(|_| {
                syntax(
                    path,
                    "integer literal out of range",
                    SourceSpan { start, end: offset },
                )
            })?)
        } else if ch.is_ascii_alphabetic() || ch == '_' || ch == '$' {
            offset += 1;
            while offset < source.len()
                && (source.as_bytes()[offset].is_ascii_alphanumeric()
                    || matches!(source.as_bytes()[offset], b'_' | b'-' | b'$'))
            {
                offset += 1;
            }
            TokenKind::Word(source[start..offset].into())
        } else if matches!(ch, '=' | '!' | '>' | '<') {
            offset += 1;
            let equals = source.as_bytes().get(offset) == Some(&b'=');
            if equals {
                offset += 1;
            }
            TokenKind::Operator(match (ch, equals) {
                ('=', true) => "==",
                ('!', true) => "!=",
                ('>', true) => ">=",
                ('<', true) => "<=",
                ('>', false) => ">",
                ('<', false) => "<",
                _ => {
                    return Err(syntax(
                        path,
                        "invalid operator",
                        SourceSpan { start, end: offset },
                    ))
                }
            })
        } else if matches!(ch, '(' | ')' | '{' | '}' | ',' | ':' | '.') {
            offset += 1;
            TokenKind::Symbol(ch)
        } else {
            return Err(syntax(
                path,
                format!("invalid character {ch}"),
                SourceSpan {
                    start,
                    end: start + ch.len_utf8(),
                },
            ));
        };
        tokens.push(Token {
            kind,
            span: SourceSpan { start, end: offset },
        });
    }
    Ok(tokens)
}
struct Parser<'a> {
    tokens: Vec<Token>,
    cursor: usize,
    source: &'a str,
    path: &'a str,
}
impl Parser<'_> {
    fn peek(&self) -> Option<&TokenKind> {
        self.tokens.get(self.cursor).map(|token| &token.kind)
    }
    fn take(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.cursor).cloned();
        self.cursor += usize::from(token.is_some());
        token
    }
    fn consume(&mut self, symbol: char) -> bool {
        if self.peek() == Some(&TokenKind::Symbol(symbol)) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn error(&self, detail: impl Into<String>) -> CompileError {
        let span = self
            .tokens
            .get(self.cursor)
            .map(|token| token.span)
            .unwrap_or(SourceSpan {
                start: self.source.len(),
                end: self.source.len(),
            });
        syntax(self.path, detail, span)
    }
    fn expect(&mut self, symbol: char) -> Result<(), CompileError> {
        if self.consume(symbol) {
            Ok(())
        } else {
            Err(self.error(format!("expected {symbol}")))
        }
    }
    fn name(&mut self) -> Result<String, CompileError> {
        match self.take() {
            Some(Token {
                kind: TokenKind::Word(name),
                ..
            }) => Ok(name),
            _ => Err(self.error("expected name")),
        }
    }
    fn expression(&mut self, min_binding: u8) -> Result<StageExpr, CompileError> {
        let start = self
            .tokens
            .get(self.cursor)
            .map_or(self.source.len(), |token| token.span.start);
        let mut left = match self.take() {
            Some(Token {
                kind: TokenKind::Word(word),
                ..
            }) if word == "not" => StageExpr::Not(Box::new(self.expression(3)?)),
            Some(Token {
                kind: TokenKind::Word(word),
                ..
            }) => match word.as_str() {
                "true" => StageExpr::Boolean(true),
                "false" => StageExpr::Boolean(false),
                "input" => StageExpr::Input(Vec::new()),
                "each" => StageExpr::Each(Vec::new()),
                "item" => StageExpr::Item(Vec::new()),
                _ => StageExpr::Name {
                    head: word,
                    path: Vec::new(),
                },
            },
            Some(Token {
                kind: TokenKind::Integer(value),
                ..
            }) => StageExpr::Integer(value),
            Some(Token {
                kind: TokenKind::Text(value),
                ..
            }) => StageExpr::Text(value),
            Some(Token {
                kind: TokenKind::Symbol('('),
                ..
            }) => {
                let inner = self.expression(0)?;
                self.expect(')')?;
                inner
            }
            Some(Token {
                kind: TokenKind::Symbol('{'),
                ..
            }) => self.record()?,
            _ => return Err(self.error("expected expression")),
        };
        loop {
            if min_binding <= 7 && self.consume('(') {
                left = self.call(left.into_unspanned())?;
                continue;
            }
            if min_binding <= 7 && self.consume('.') {
                let name = self.name()?;
                left = match left.into_unspanned() {
                    StageExpr::Input(mut path) => {
                        path.push(name);
                        StageExpr::Input(path)
                    }
                    StageExpr::Each(mut path) => {
                        path.push(name);
                        StageExpr::Each(path)
                    }
                    StageExpr::Item(mut path) => {
                        path.push(name);
                        StageExpr::Item(path)
                    }
                    StageExpr::Name { head, mut path } => {
                        path.push(name);
                        StageExpr::Name { head, path }
                    }
                    StageExpr::Outcome { unit, mut path } => {
                        path.push(name);
                        StageExpr::Outcome { unit, path }
                    }
                    StageExpr::Latest { artifact, mut path } => {
                        path.push(name);
                        StageExpr::Latest { artifact, path }
                    }
                    StageExpr::Lookup {
                        source,
                        field,
                        key,
                        mut path,
                    } => {
                        path.push(name);
                        StageExpr::Lookup {
                            source,
                            field,
                            key,
                            path,
                        }
                    }
                    StageExpr::Default {
                        value,
                        fallback,
                        mut path,
                    } => {
                        path.push(name);
                        StageExpr::Default {
                            value,
                            fallback,
                            path,
                        }
                    }
                    StageExpr::Require { value, mut path } => {
                        path.push(name);
                        StageExpr::Require { value, path }
                    }
                    _ => return Err(self.error("field path is not allowed here")),
                };
                if let StageExpr::Name { head, path } = &left {
                    if path.first().is_some_and(|part| part == "outcome") {
                        left = StageExpr::Outcome {
                            unit: head.clone(),
                            path: path[1..].to_vec(),
                        };
                    }
                }
                continue;
            }
            let (left_bp, right_bp, operator) = match self.peek() {
                Some(TokenKind::Word(word)) if word == "or" => (1, 2, "or"),
                Some(TokenKind::Word(word)) if word == "and" => (2, 3, "and"),
                Some(TokenKind::Operator(operator)) => (4, 5, *operator),
                _ => break,
            };
            if left_bp < min_binding {
                break;
            }
            self.take();
            let right = self.expression(right_bp)?;
            left = match operator {
                "or" => StageExpr::Or(Box::new(left), Box::new(right)),
                "and" => StageExpr::And(Box::new(left), Box::new(right)),
                "==" | "!=" => StageExpr::Equality {
                    is_negated: operator == "!=",
                    left: Box::new(left),
                    right: Box::new(right),
                },
                _ => StageExpr::Compare {
                    operator: match operator {
                        ">" => Comparison::Greater,
                        ">=" => Comparison::GreaterOrEqual,
                        "<" => Comparison::Less,
                        _ => Comparison::LessOrEqual,
                    },
                    left: Box::new(left),
                    right: Box::new(right),
                },
            };
        }
        let end = self
            .tokens
            .get(self.cursor.saturating_sub(1))
            .map_or(start, |token| token.span.end);
        Ok(StageExpr::Spanned(
            Box::new(left),
            SourceSpan { start, end },
        ))
    }
    fn record(&mut self) -> Result<StageExpr, CompileError> {
        let mut fields = Vec::new();
        let mut seen = BTreeSet::new();
        if self.consume('}') {
            return Ok(StageExpr::Record(fields));
        }
        loop {
            let key = self.name()?;
            if !seen.insert(key.clone()) {
                let span = self.tokens[self.cursor - 1].span;
                return Err(CompileError::new(
                    CheckKind::Schema,
                    self.path,
                    span,
                    format!("duplicate record field {key}"),
                ));
            }
            self.expect(':')?;
            fields.push((key, self.expression(0)?));
            if self.consume('}') {
                break;
            }
            self.expect(',')?;
        }
        Ok(StageExpr::Record(fields))
    }
    fn call(&mut self, callee: StageExpr) -> Result<StageExpr, CompileError> {
        let StageExpr::Name { head, path } = callee else {
            return Err(self.error("call target must be a name"));
        };
        if !path.is_empty() {
            return Err(self.error("call target must be a name"));
        }
        let count = match head.as_str() {
            "len" | "published" | "approved" | "changes_requested" | "latest" | "require" => 1,
            "every" | "any" | "filter" | "map" | "contains" | "default" => 2,
            "lookup" | "valid_graph" => 3,
            _ => return Err(self.error(format!("unknown function {head}"))),
        };
        let mut args = Vec::new();
        if !self.consume(')') {
            loop {
                let is_name = match head.as_str() {
                    "published" | "approved" | "changes_requested" | "latest" => args.is_empty(),
                    "lookup" | "valid_graph" => {
                        args.len() == 1 || (head == "valid_graph" && args.len() == 2)
                    }
                    _ => false,
                };
                args.push(if is_name {
                    StageExpr::Name {
                        head: self.name()?,
                        path: Vec::new(),
                    }
                } else {
                    self.expression(0)?
                });
                if self.consume(')') {
                    break;
                }
                self.expect(',')?;
            }
        }
        if args.len() != count {
            return Err(self.error(format!("{head} takes {count} arguments")));
        }
        let mut args = args.into_iter();
        let first = args.next().unwrap();
        let boxed = Box::new(first.clone());
        let name = |expr: StageExpr| match expr.into_unspanned() {
            StageExpr::Name { head, path } if path.is_empty() => Some(head),
            _ => None,
        };
        Ok(match head.as_str() {
            "len" => StageExpr::Len(boxed),
            "require" => StageExpr::Require {
                value: boxed,
                path: Vec::new(),
            },
            "published" => StageExpr::Published(
                name(first).ok_or_else(|| self.error("published needs artifact name"))?,
            ),
            "approved" => StageExpr::Approved(
                name(first).ok_or_else(|| self.error("approved needs artifact name"))?,
            ),
            "changes_requested" => StageExpr::ChangesRequested(
                name(first).ok_or_else(|| self.error("changes_requested needs artifact name"))?,
            ),
            "latest" => StageExpr::Latest {
                artifact: name(first).ok_or_else(|| self.error("latest needs artifact name"))?,
                path: Vec::new(),
            },
            "every" => StageExpr::Every {
                source: boxed,
                predicate: Box::new(args.next().unwrap()),
            },
            "any" => StageExpr::Any {
                source: boxed,
                predicate: Box::new(args.next().unwrap()),
            },
            "filter" => StageExpr::Filter {
                source: boxed,
                predicate: Box::new(args.next().unwrap()),
            },
            "map" => StageExpr::MapOf {
                source: boxed,
                value: Box::new(args.next().unwrap()),
            },
            "contains" => StageExpr::Contains {
                source: boxed,
                value: Box::new(args.next().unwrap()),
            },
            "default" => StageExpr::Default {
                value: boxed,
                fallback: Box::new(args.next().unwrap()),
                path: Vec::new(),
            },
            "lookup" => StageExpr::Lookup {
                source: boxed,
                field: name(args.next().unwrap())
                    .ok_or_else(|| self.error("lookup field is not a name"))?,
                key: Box::new(args.next().unwrap()),
                path: Vec::new(),
            },
            _ => StageExpr::ValidGraph {
                source: boxed,
                key_field: name(args.next().unwrap())
                    .ok_or_else(|| self.error("valid_graph field is not a name"))?,
                dependencies_field: name(args.next().unwrap())
                    .ok_or_else(|| self.error("valid_graph field is not a name"))?,
            },
        })
    }
}
pub(crate) fn parse_expression(text: &str, path: &str) -> Result<StageExpr, CompileError> {
    let mut parser = Parser {
        tokens: tokenize(text, path)?,
        cursor: 0,
        source: text,
        path,
    };
    let expression = parser.expression(0)?;
    if parser.peek().is_some() {
        return Err(parser.error("unexpected token after expression"));
    }
    Ok(expression.into_unspanned())
}

pub(crate) fn parse_repository<'a>(text: &'a str, path: &str) -> Result<&'a str, CompileError> {
    let mut parser = Parser {
        tokens: tokenize(text, path)?,
        cursor: 0,
        source: text,
        path,
    };
    if parser.name()? != "repository" {
        return Err(parser.error("workspace must be repository(<expr>)"));
    }
    parser.expect('(')?;
    let start = parser
        .tokens
        .get(parser.cursor)
        .map(|token| token.span.start)
        .unwrap_or(text.len());
    parser.expression(0)?;
    let end = parser
        .tokens
        .get(parser.cursor.saturating_sub(1))
        .map(|token| token.span.end)
        .unwrap_or(start);
    parser.expect(')')?;
    if parser.peek().is_some() {
        return Err(parser.error("unexpected token after repository"));
    }
    Ok(&text[start..end])
}
