import { Fragment } from "react";
import { stageElementHref, type StageSectionProps } from "../../lib/stage-inspector";
interface LetExpressionProps extends StageSectionProps { expression: string }
export function LetExpression({ model, expression }: LetExpressionProps) {
  return <code>{expression.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b[A-Za-z_][A-Za-z0-9_]*\b)/).map((text, index) =>
    Object.hasOwn(model.stage.let ?? {}, text) ? <a key={index} href={stageElementHref(model, "let", text)}>{text}</a> : Object.hasOwn(model.stage.artifacts, text) ? <a key={index} href={stageElementHref(model, "artifact", text)}>{text}</a> : <Fragment key={index}>{text}</Fragment>)}</code>;
}
