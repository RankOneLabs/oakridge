import { Fragment } from "react";
import { stageElementHref, type StageSectionProps } from "../../lib/stage-inspector";
interface LetExpressionProps extends StageSectionProps {
  expression: string;
}
export function LetExpression({ model, expression }: LetExpressionProps) {
  // Words follow the compiler lexer, so `build-result` and `$x` stay whole identifiers.
  const tokens = expression.split(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$-]*)/,
  );
  // A word after `.` is a field name, never a let binding or artifact.
  const isFieldAccess = (index: number) => Boolean(tokens[index - 1]?.trimEnd().endsWith("."));
  return (
    <code>
      {tokens.map((text, index) =>
        isFieldAccess(index) ? (
          <Fragment key={index}>{text}</Fragment>
        ) : Object.hasOwn(model.stage.let ?? {}, text) ? (
          <a key={index} href={stageElementHref(model, { kind: "let", name: text })}>
            {text}
          </a>
        ) : Object.hasOwn(model.stage.artifacts, text) ? (
          <a key={index} href={stageElementHref(model, { kind: "artifact", name: text })}>
            {text}
          </a>
        ) : (
          <Fragment key={index}>{text}</Fragment>
        ),
      )}
    </code>
  );
}
