import * as React from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { renderHighlightedText } from "@/lib/text";
import { ImageLightbox } from "@/components/shared/ImageLightbox";
import { assetUrl, basenameOf, isAbsoluteLocalPath } from "@/lib/asset";

function highlightChildren(children: ReactNode, tokens: string[]): ReactNode {
  if (!tokens.length) return children;
  return React.Children.map(children, (child) => {
    if (typeof child === "string") return renderHighlightedText(child, tokens);
    if (React.isValidElement(child)) {
      const element = child as React.ReactElement<{ children?: ReactNode }>;
      return React.cloneElement(element, {
        ...element.props,
        children: highlightChildren(element.props.children, tokens),
      });
    }
    return child;
  });
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  xml: "xml",
  sql: "sql",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  php: "php",
  vue: "xml",
  svelte: "xml",
};

interface MdastCodeNode {
  type: string;
  lang?: string | null;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdastCodeNode[];
}

function remarkCursorCodeRef() {
  return (tree: MdastCodeNode) => {
    const walk = (node: MdastCodeNode) => {
      if (node?.type === "code" && typeof node.lang === "string") {
        const m = /^(\d+):(\d+):(.+)$/.exec(node.lang);
        if (m) {
          const filepath = m[3];
          const basename = filepath.split("/").pop() || filepath;
          const ext = basename.includes(".")
            ? basename.split(".").pop()!.toLowerCase()
            : "";
          node.lang = EXT_TO_LANG[ext] || ext || null;
          const data = (node.data ??= {});
          data.hProperties = {
            ...(data.hProperties || {}),
            "data-file": basename,
          };
        }
      }
      if (Array.isArray(node?.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}

function extractCodeMeta(children: ReactNode): {
  lang?: string;
  file?: string;
} {
  const first = React.Children.toArray(children)[0];
  if (!React.isValidElement(first)) return {};
  const props = first.props as { className?: string; "data-file"?: string };
  const match = /language-([\w-]+)/.exec(props.className ?? "");
  return { lang: match?.[1], file: props["data-file"] };
}

interface MarkdownImgProps {
  src?: string;
  alt?: string;
  title?: string;
}

/**
 * Markdown <img>. Local absolute paths are routed through `/api/asset` so
 * the backend can stream them safely; remote URLs are rendered as-is.
 * Clicking either opens the shared lightbox so users can zoom and copy
 * the path.
 */
function MarkdownImage({ src, alt, title }: MarkdownImgProps) {
  const [open, setOpen] = React.useState(false);
  if (!src) return null;
  const isLocal = isAbsoluteLocalPath(src);
  const resolvedSrc = isLocal ? assetUrl(src) : src;
  const lightboxPath = isLocal ? src : src;
  return (
    <>
      <img
        src={resolvedSrc}
        alt={alt ?? basenameOf(src)}
        title={title ?? src}
        loading="lazy"
        draggable={false}
        onClick={() => setOpen(true)}
        className="cursor-zoom-in rounded-md border border-border bg-background-soft transition-shadow hover:shadow-editorial"
      />
      <ImageLightbox
        paths={[lightboxPath]}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

interface MarkdownProps {
  source: string;
  queryTokens?: string[];
  className?: string;
}

function Markdown({ source, queryTokens = [], className }: MarkdownProps) {
  const hl = (children: ReactNode) => highlightChildren(children, queryTokens);
  return (
    <div className={cn("markdown-body", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCursorCodeRef]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          p: ({ children }) => <p>{hl(children)}</p>,
          h1: ({ children }) => <h1>{hl(children)}</h1>,
          h2: ({ children }) => <h2>{hl(children)}</h2>,
          h3: ({ children }) => <h3>{hl(children)}</h3>,
          h4: ({ children }) => <h4>{hl(children)}</h4>,
          h5: ({ children }) => <h5>{hl(children)}</h5>,
          h6: ({ children }) => <h6>{hl(children)}</h6>,
          li: ({ children }) => <li>{hl(children)}</li>,
          strong: ({ children }) => <strong>{hl(children)}</strong>,
          em: ({ children }) => <em>{hl(children)}</em>,
          blockquote: ({ children }) => <blockquote>{hl(children)}</blockquote>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {hl(children)}
            </a>
          ),
          pre: ({ children }) => {
            const { lang, file } = extractCodeMeta(children);
            return (
              <pre data-lang={lang} data-file={file}>
                {children}
              </pre>
            );
          },
          code: ({ className: codeClassName, children }) => (
            <code className={codeClassName}>{hl(children)}</code>
          ),
          img: ({ src, alt, title }) => (
            <MarkdownImage
              src={typeof src === "string" ? src : undefined}
              alt={typeof alt === "string" ? alt : undefined}
              title={typeof title === "string" ? title : undefined}
            />
          ),
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
          td: ({ children }) => <td>{hl(children)}</td>,
          th: ({ children }) => <th>{hl(children)}</th>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

export { Markdown };
