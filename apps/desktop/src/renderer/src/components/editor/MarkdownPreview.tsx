import { BLUEPRINT_FILE_SCHEME } from '@runova/core';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';

/** Extensions the app serves and a browser can play in place. */
const VIDEO_URL = /[.](mp4|webm)([?#]|$)/i;

/**
 * react-markdown strips any URL whose scheme it does not recognize, which would
 * quietly blank every attached file. The app serves its own files over its own
 * scheme, so that one is let through and everything else keeps the default
 * treatment.
 */
function transformUrl(url: string): string {
  return url.startsWith(`${BLUEPRINT_FILE_SCHEME}:`) ? url : defaultUrlTransform(url);
}

export interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

/**
 * Renders markdown at document scale: real heading sizes, spacing between
 * blocks. `MarkdownMessage` is the same idea shrunk to fit a chat bubble, so
 * the two deliberately stay separate rather than sharing a scale that suits
 * neither.
 */
export function MarkdownPreview({ content, className }: MarkdownPreviewProps): React.JSX.Element {
  const persian = persianTextProps(content);
  return (
    <div
      dir={persian.dir}
      className={cn(
        'space-y-3 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        persian.className,
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transformUrl}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-6 border-b border-border pb-1.5 text-2xl font-semibold tracking-tight">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-5 border-b border-border pb-1 text-xl font-semibold tracking-tight">
              {children}
            </h2>
          ),
          h3: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-base font-semibold">{children}</h4>,
          h5: ({ children }) => <h5 className="mb-1.5 mt-3 text-sm font-semibold">{children}</h5>,
          h6: ({ children }) => (
            <h6 className="mb-1.5 mt-3 text-sm font-semibold text-muted-foreground">{children}</h6>
          ),
          p: ({ children }) => <p className="my-2">{children}</p>,
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
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
          // GFM task lists render as `<li>` with a checkbox child; dropping the
          // marker keeps the checkbox from sitting next to a stray bullet.
          li: ({ children, className: liClassName }) => (
            <li className={cn(/task-list-item/.test(liClassName ?? '') && 'list-none -ml-4')}>
              {children}
            </li>
          ),
          input: ({ checked, type }) =>
            type === 'checkbox' ? (
              <input type="checkbox" checked={checked} readOnly className="mr-2 align-middle" />
            ) : null,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-border" />,
          code: ({ className: codeClassName, children, ...props }) => {
            const isBlock = /language-/.test(codeClassName ?? '');
            if (isBlock) {
              return (
                <code className={cn('font-mono text-xs', codeClassName)} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-lg bg-foreground/[0.06] p-3 text-xs">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-foreground/[0.04] px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
          // Markdown has one media syntax, so an attached video arrives here as
          // an image and is swapped for a player. Anything the browser can't
          // play still renders as an image, i.e. visibly broken rather than
          // silently missing.
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : undefined;
            if (url && VIDEO_URL.test(url)) {
              return (
                <video
                  src={url}
                  controls
                  preload="metadata"
                  aria-label={alt || 'Attached video'}
                  className="max-w-full rounded-lg"
                >
                  <track kind="captions" />
                </video>
              );
            }
            return <img src={url} alt={alt} className="max-w-full rounded-lg" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
