import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type ApiClient } from "../../api";
import { copyText } from "../../copy-text";
import { FileLink } from "./FileLink";
import {
  type BlockToken,
  type InlineToken,
  parseBlocks,
} from "./markdown-parser";

interface MarkdownContentProps {
  text: string;
  client: ApiClient;
  toast: (message: string) => void;
}

/** 助手回复的 Markdown 排版渲染：长回复分段/标题/列表，围栏代码块带复制按钮，/v1 路径渲染为下载 chip。 */
export function MarkdownContent({ text, client, toast }: MarkdownContentProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => (
        <BlockElement key={index} block={block} client={client} toast={toast} />
      ))}
    </div>
  );
}

function BlockElement({
  block,
  client,
  toast,
}: {
  block: BlockToken;
  client: ApiClient;
  toast: (message: string) => void;
}) {
  switch (block.type) {
    case "paragraph":
      return <p>{renderInline(block.inlines, client, toast)}</p>;
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag>{renderInline(block.inlines, client, toast)}</Tag>;
    }
    case "code-block":
      return <CodeBlock lang={block.lang} code={block.code} />;
    case "quote":
      return <blockquote>{renderInline(block.inlines, client, toast)}</blockquote>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, client, toast)}</li>
          ))}
        </List>
      );
    }
    case "hr":
      return <hr />;
  }
}

function renderInline(
  tokens: InlineToken[],
  client: ApiClient,
  toast: (message: string) => void,
): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return token.text;
      case "strong":
        return <strong key={index}>{token.text}</strong>;
      case "emphasis":
        return <em key={index}>{token.text}</em>;
      case "deleted":
        return <del key={index}>{token.text}</del>;
      case "inline-code":
        return <code key={index}>{token.code}</code>;
      case "link":
        return isControlledPath(token.href)
          ? <FileLink key={index} url={token.href} client={client} toast={toast} />
          : (
            <a key={index} href={token.href} target="_blank" rel="noreferrer">
              {token.text || token.href}
            </a>
          );
      case "bare-url":
        return isControlledPath(token.raw)
          ? <FileLink key={index} url={token.raw} client={client} toast={toast} />
          : (
            <a key={index} href={token.raw} target="_blank" rel="noreferrer">
              {token.raw}
            </a>
          );
    }
  });
}

function isControlledPath(value: string): boolean {
  return value.startsWith("/v1/media/") || value.startsWith("/v1/artifacts/");
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  async function copy() {
    if (await copyText(code)) {
      setCopied(true);
      timerRef.current = window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <figure className="code-block">
      <figcaption className="code-block-head">
        <span className="code-block-lang">{lang || "code"}</span>
        <button className="code-copy" type="button" onClick={() => void copy()}>
          {copied
            ? <Check aria-hidden="true" size={13} />
            : <Copy aria-hidden="true" size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  );
}
