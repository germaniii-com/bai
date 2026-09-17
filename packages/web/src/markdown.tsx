import { memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./components";

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

/**
 * Block code arrives as <pre><code class="language-x">…</code></pre>; the
 * language label rides the fence. A wrapper holds a copy button pinned
 * above the horizontally-scrollable <pre> so the button stays put when
 * long lines scroll (a sibling rather than a child of the scroller). The
 * raw text is read from the code element at click time — never from the
 * language label — and the button flips to a check for two seconds on
 * success (the same affordance as the per-message copy action).
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const child = Array.isArray(children) ? children[0] : children;
  const className =
    typeof child === "object" && child !== null && "props" in child
      ? ((child.props as { className?: string }).className ?? "")
      : "";
  const lang = /language-(\S+)/.exec(className)?.[1];

  const copy = async (): Promise<void> => {
    const text = bodyRef.current?.querySelector("code")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (denied permission, insecure context) — no feedback to show.
    }
  };

  return (
    <div className="md-code-block">
      <pre className="md-code" ref={bodyRef}>
        {lang !== undefined && <span className="md-code-lang">{lang}</span>}
        {children}
      </pre>
      <IconButton
        className="md-code-copy"
        label={copied ? "Copied" : "Copy code"}
        hint={copied ? "Copied" : "Copy code"}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </IconButton>
    </div>
  );
}

const components: Components = {
  // Links open in a new tab and never grant the destination page access
  // to this app's window context.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // The code element passes through (styling targets `pre.md-code code`);
  // inline code skips this.
  pre: CodeBlock,
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
