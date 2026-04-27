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

// remark/rehype plugin tuples are pure references — define them once at module
// scope so ReactMarkdown's plugin pipeline doesn't reset every render.
const REMARK_PLUGINS = [remarkGfm, remarkCursorCodeRef] as const;
const REHYPE_PLUGINS = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
] as const;

function MarkdownImpl({ source, queryTokens = [], className }: MarkdownProps) {
  // Building a fresh `components` object every render forces ReactMarkdown to
  // re-key the entire rendered tree, which torpedoes any internal memoization.
  // Tying the object identity to `queryTokens` (with a join key) means we
  // only rebuild when the tokens that drive `highlightChildren` actually
  // change — and stays stable when only the parent re-renders for unrelated
  // reasons (e.g. activeMatch on a sibling).
  const tokensKey = queryTokens.join("\u0001");
  const components = React.useMemo(() => {
    const hl = (children: ReactNode) => highlightChildren(children, queryTokens);
    return {
      p: ({ children }: { children?: ReactNode }) => <p>{hl(children)}</p>,
      h1: ({ children }: { children?: ReactNode }) => <h1>{hl(children)}</h1>,
      h2: ({ children }: { children?: ReactNode }) => <h2>{hl(children)}</h2>,
      h3: ({ children }: { children?: ReactNode }) => <h3>{hl(children)}</h3>,
      h4: ({ children }: { children?: ReactNode }) => <h4>{hl(children)}</h4>,
      h5: ({ children }: { children?: ReactNode }) => <h5>{hl(children)}</h5>,
      h6: ({ children }: { children?: ReactNode }) => <h6>{hl(children)}</h6>,
      li: ({ children }: { children?: ReactNode }) => <li>{hl(children)}</li>,
      strong: ({ children }: { children?: ReactNode }) => (
        <strong>{hl(children)}</strong>
      ),
      em: ({ children }: { children?: ReactNode }) => <em>{hl(children)}</em>,
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote>{hl(children)}</blockquote>
      ),
      a: ({ children, href }: { children?: ReactNode; href?: string }) => (
        <a href={href} target="_blank" rel="noreferrer">
          {hl(children)}
        </a>
      ),
      pre: ({ children }: { children?: ReactNode }) => {
        const { lang, file } = extractCodeMeta(children);
        return (
          <pre data-lang={lang} data-file={file}>
            {children}
          </pre>
        );
      },
      code: ({
        className: codeClassName,
        children,
      }: {
        className?: string;
        children?: ReactNode;
      }) => <code className={codeClassName}>{hl(children)}</code>,
      img: ({
        src,
        alt,
        title,
      }: {
        src?: unknown;
        alt?: unknown;
        title?: unknown;
      }) => (
        <MarkdownImage
          src={typeof src === "string" ? src : undefined}
          alt={typeof alt === "string" ? alt : undefined}
          title={typeof title === "string" ? title : undefined}
        />
      ),
      table: ({ children }: { children?: ReactNode }) => (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      ),
      td: ({ children }: { children?: ReactNode }) => <td>{hl(children)}</td>,
      th: ({ children }: { children?: ReactNode }) => <th>{hl(children)}</th>,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensKey]);

  return (
    <div className={cn("markdown-body", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS as never}
        rehypePlugins={REHYPE_PLUGINS as never}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Memoize on (source, tokens, className). Without this, every keystroke that
// changed an unrelated piece of parent state would force ReactMarkdown to
// re-parse the markdown AST and re-run rehype-highlight — by far the most
// expensive cost on screen for long sessions.
const Markdown = React.memo(MarkdownImpl, (prev, next) => {
  if (prev.source !== next.source) return false;
  if (prev.className !== next.className) return false;
  const a = prev.queryTokens ?? [];
  const b = next.queryTokens ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
});

export { Markdown };
