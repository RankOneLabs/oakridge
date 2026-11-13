import { Fragment } from "react";
import { stageElementHref, type StageSectionProps } from "../../lib/stage-inspector";
interface LetExpressionProps extends StageSectionProps {
  expression: string;
}
export function LetExpression({ model, expression }: LetExpressionProps) {
  const tokens = expression.split(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b[A-Za-z_][A-Za-z0-9_]*\b)/,
  );
  return (
    <code>
      {tokens.map((text, index) =>
        Object.hasOwn(model.stage.let ?? {}, text) ? (
          <a key={index} href={stageElementHref(model, { kind: "let", name: text })}>
            {text}
          </a>
        ) : Object.hasOwn(model.stage.artifacts, text) &&
          !tokens[index - 1]?.trimEnd().endsWith(".") ? (
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
