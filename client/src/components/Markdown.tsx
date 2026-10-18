import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for assistant messages — styled to the harness theme.
 * User messages stay plain text; this is only used for model output.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body max-w-full min-w-0 overflow-x-auto text-[13px] leading-relaxed text-ink-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Full-width, non-breaking layout
          p: (props) => <p className="mb-2 last:mb-0 whitespace-pre-wrap break-words" {...props} />,
          pre: (props) => (
            <pre
              className="my-2 max-w-full overflow-x-auto rounded-md border border-line bg-surface-0
                p-2.5 text-[11.5px] leading-relaxed"
              {...props}
            />
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <code className={`${className ?? ""} font-mono text-ink-2`} {...props}>{children}</code>
            ) : (
              <code
                className="rounded border border-line bg-surface-0 px-1 py-px font-mono
                  text-[11.5px] text-zinc-300"
                {...props}
              >
                {children}
              </code>
            );
          },
          ul: (props) => <ul className="mb-2 ml-5 list-disc space-y-1" {...props} />,
          ol: (props) => <ol className="mb-2 ml-5 list-decimal space-y-1" {...props} />,
          li: (props) => <li className="break-words" {...props} />,
          h1: (props) => <h1 className="mb-2 mt-1 border-b border-line pb-1 text-base font-semibold" {...props} />,
          h2: (props) => <h2 className="mb-1.5 mt-2 text-sm font-semibold" {...props} />,
          h3: (props) => <h3 className="mb-1.5 mt-2 text-[13px] font-semibold text-zinc-200" {...props} />,
          a: (props) => <a className="text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100" target="_blank" rel="noreferrer" {...props} />,
          blockquote: (props) => <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-ink-2" {...props} />,
          hr: () => <hr className="my-3 border-line" />,
          strong: (props) => <strong className="font-semibold text-zinc-100" {...props} />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...props} />
            </div>
          ),
          th: (props) => <th className="border border-line bg-surface-0 px-2 py-1 text-left font-medium" {...props} />,
          td: (props) => <td className="border border-line px-2 py-1 align-top" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
