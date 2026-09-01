export function UserMessage({ text }: { text: string }) {
  // Slash invocations collapse behind their trigger line: the expanded
  // body is what the agent received, the summary is what the operator
  // tapped or typed.
  const slashMatch = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (slashMatch) {
    const [, name, args] = slashMatch;
    return (
      <div className="row row-user">
        <details className="bubble bubble-user bubble-user-slash">
          <summary>
            <span className="bubble-slash-name">/{name}</span>
            {args && <span className="bubble-slash-args">{args.split("\n", 1)[0]}</span>}
          </summary>
          <pre className="bubble-slash-body">{text}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="row row-user">
      <div className="bubble bubble-user">{text}</div>
    </div>
  );
}
