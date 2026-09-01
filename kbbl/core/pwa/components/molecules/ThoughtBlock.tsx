export function ThoughtBlock({ text }: { text: string }) {
  return (
    <details className="row row-thinking">
      <summary>thinking</summary>
      <pre>{text}</pre>
    </details>
  );
}
