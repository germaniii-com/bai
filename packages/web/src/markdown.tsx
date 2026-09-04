import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for assistant bodies (and thinking transcripts).
 *
 * react-markdown renders React components from the markdown AST — no
 * `innerHTML`, so model output is XSS-safe by construction. remark-gfm
 * adds tables, strikethrough, task lists and autolinks. Re-parses on
 * every text change: streaming deltas mutate `payload.text` in place and
 * re-render through this component; marked-AST parsing at chat-message
 * sizes is well under a millisecond, so no streaming-specific handling.
 *
 * Styling lives in styles.css under `.md` — the component only provides
 * structure (class names, link targets) and never inline styles.
 */

const components: Components = {
  // Links open in a new tab and never grant the destination page access
  // to this app's window context.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Block code arrives as <pre><code class="language-x">…</code></pre>;
  // the language label rides the fence. The code element itself passes
  // through (styling targets `pre.md-code code`); inline code skips this.
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      typeof child === "object" && child !== null && "props" in child
        ? ((child.props as { className?: string }).className ?? "")
        : "";
    const lang = /language-(\S+)/.exec(className)?.[1];
    return (
      <pre className="md-code">
        {lang !== undefined && <span className="md-code-lang">{lang}</span>}
        {children}
      </pre>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (text.trim().length === 0) return null;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
