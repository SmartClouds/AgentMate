import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export interface MarkdownMessageProps {
  content: string;
  className?: string;
}

/** Long words (URLs, paths, hashes) break anywhere rather than push the chat sideways. */
const WRAP = 'break-words [overflow-wrap:anywhere]';

/**
 * Renders chat message content as markdown, scoped to look right inside a small chat bubble.
 * Nothing in it widens the bubble: text and code wrap, and only a wide table scrolls, in its box.
 */
export function MarkdownMessage({ content, className }: MarkdownMessageProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'space-y-2 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className={cn('whitespace-pre-wrap', WRAP)}>{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2 hover:no-underline"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className={WRAP}>{children}</li>,
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ className: codeClassName, children, ...props }) => {
            const isBlock = /language-/.test(codeClassName ?? '');
            if (isBlock) {
              return (
                <code
                  className={cn(
                    'block whitespace-pre-wrap rounded-lg bg-foreground/[0.08] p-3 font-mono text-xs',
                    WRAP,
                    codeClassName,
                  )}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="break-all rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="whitespace-pre-wrap">{children}</pre>,
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
