import { Fragment } from "react";
import { tokenizeExpression } from "../../lib/artifact-contracts";
import { stageElementHref, type StageSectionProps } from "../../lib/stage-inspector";
interface LetExpressionProps extends StageSectionProps {
  expression: string;
}
export function LetExpression({ model, expression }: LetExpressionProps) {
  const tokens = tokenizeExpression(expression);
  return (
    <code>
      {tokens.map(({ text, is_identifier }, index) =>
        !is_identifier ? (
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
