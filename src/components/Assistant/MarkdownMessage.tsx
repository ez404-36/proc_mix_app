import type { AnchorHTMLAttributes } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  text: string;
}

type MarkdownAnchorProps = Pick<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "children" | "href"
>;

/** Only HTTPS and HTTP links are opened; every other scheme is inert text. */
function isHttpUrl(href: string | undefined): href is string {
  return /^https?:\/\//i.test(href ?? "");
}

function MarkdownAnchor({ children, href }: MarkdownAnchorProps): ReactElement {
  if (!isHttpUrl(href)) {
    return <span>{children}</span>;
  }

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    void (async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    })().catch((error: unknown) => {
      console.warn("failed to open assistant markdown link", error);
    });
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

function MarkdownImage(): null {
  return null;
}

const markdownComponents: Components = {
  a: MarkdownAnchor,
  img: MarkdownImage,
};

/**
 * Renders provider/user markdown without raw HTML. The markdown parser is the
 * sanitization boundary: it never evaluates HTML, and the component allow-list
 * constrains link schemes and excludes remote image loading.
 */
export function MarkdownMessage({ text }: MarkdownMessageProps): ReactElement {
  return (
    <div className="assistant-panel__markdown">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
