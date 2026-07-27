import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'katex/dist/katex.min.css';

// 白名单 schema:在默认基础上放行常见无害格式标签,并保留 katex 需要的 class 属性。
// 注意 defaultSchema 本身已剥离 <script>/<iframe>、on* 事件属性、javascript: 协议。
const sanitizeSchema = {
    ...defaultSchema,
    // 放行常见格式标签 + katex 渲染产物用到的 span/div 及其 class
    tagNames: [
        ...(defaultSchema.tagNames || []),
        'u', 's', 'sub', 'sup', 'kbd', 'mark', 'small',
    ],
    attributes: {
        ...defaultSchema.attributes,
        '*': [...(defaultSchema.attributes?.['*'] || []), 'className', 'class', 'style'],
        span: [...(defaultSchema.attributes?.span || []), 'class', 'style'],
        div: [...(defaultSchema.attributes?.div || []), 'class', 'style'],
    },
    // 允许保留 class/style,以便 katex 与自定义样式生效;rehype-sanitize 默认会清洗 style 中的危险值
    strip: ['script', 'iframe', 'object', 'embed'],
};

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

type CodeRendererProps = React.ComponentProps<'code'> & {
    inline?: boolean;
};

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
    // Preprocess content to ensure proper paragraph breaks and LaTeX rendering
    // Convert single line breaks to double line breaks for better readability
    const processedContent = content
        // First, convert literal \n sequences to actual newlines (fix for AI responses)
        .replace(/\\n/g, '\n')
        // Preserve existing double line breaks with a unique marker
        .replace(/\n\n/g, '\n\n###PRESERVE_BREAK###\n\n')
        // Convert patterns that should be new paragraphs
        .replace(/([。！？；])\n(?!\n)/g, '$1\n\n')  // Chinese punctuation followed by single newline
        .replace(/([.!?;])\s*\n(?!\n)/g, '$1\n\n')   // English punctuation followed by single newline
        .replace(/(\d+\))\s*\n(?!\n)/g, '$1\n\n')    // Numbered items like (1), (2)
        .replace(/([\u2460-\u2473])\s*\n(?!\n)/g, '$1\n\n')  // Circled numbers ①②③
        // Fix: Remove indentation for lines starting with circled numbers or (n) to prevent code block rendering
        .replace(/\n\s+([\u2460-\u2473])/g, '\n$1')
        .replace(/\n\s+(\d+\))/g, '\n$1')
        // Fix LaTeX formulas: Ensure proper spacing around $ delimiters
        // 只匹配单行内、长度有限(≤80 字符)的内联公式,避免不成对的 $ 把跨段正文吞成数学表达式。
        // 旧版 `\$[^$]+\$` 因贪婪且可跨行,会让散落的 $ 之间的正文在 remark-math 阶段被整体丢弃。
        .replace(/([^\s$])(\$[^\n$]{1,80}\$)([^\s$])/g, '$1 $2 $3')
        // Restore preserved double line breaks (use flexible whitespace matching)
        .replace(/\s*###PRESERVE_BREAK###\s*/g, '\n\n');

    return (
        <div className={`markdown-content overflow-x-auto min-w-0 ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkMath, remarkGfm]}
                // 顺序很重要:raw 先解析原始 HTML → sanitize 白名单清洗 → katex 渲染公式。
                // 缺 rehype-raw 时,粘贴文本里的 <...>(如 a<b、<cost>)会被 react-markdown 当作
                // HTML 标签直接丢弃,造成"粘贴丢字"。加 raw 后由 sanitize 剥离危险标签/属性。
                rehypePlugins={[
                    rehypeRaw,
                    [rehypeSanitize, sanitizeSchema],
                    rehypeKatex,
                ]}
                components={{
                    // 自定义样式
                    h1: ({ ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4" {...props} />,
                    h2: ({ ...props }) => <h2 className="text-xl font-bold mt-5 mb-3" {...props} />,
                    h3: ({ ...props }) => <h3 className="text-lg font-bold mt-4 mb-2" {...props} />,
                    p: ({ ...props }) => <p className="mb-3 leading-relaxed" {...props} />,
                    ul: ({ ...props }) => <ul className="list-disc list-inside mb-3 space-y-1" {...props} />,
                    ol: ({ ...props }) => <ol className="list-decimal list-inside mb-3 space-y-1" {...props} />,
                    li: ({ ...props }) => <li className="ml-4" {...props} />,
                    blockquote: ({ ...props }) => (
                        <blockquote className="border-l-4 border-primary pl-4 italic my-4 text-muted-foreground" {...props} />
                    ),
                    code: ({ inline, children, ...props }: CodeRendererProps) => {
                        if (inline) {
                            return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-foreground" {...props}>{children}</code>;
                        }
                        return (
                            <code className="block bg-muted p-4 rounded-lg overflow-x-auto my-3 font-mono text-sm" {...props}>
                                {children}
                            </code>
                        );
                    },
                    table: ({ ...props }) => (
                        <div className="overflow-x-auto my-4">
                            <table className="min-w-full border-collapse border border-border" {...props} />
                        </div>
                    ),
                    th: ({ ...props }) => (
                        <th className="border border-border px-4 py-2 bg-muted font-semibold text-left" {...props} />
                    ),
                    td: ({ ...props }) => (
                        <td className="border border-border px-4 py-2" {...props} />
                    ),
                    strong: ({ ...props }) => <strong className="font-bold text-foreground" {...props} />,
                    em: ({ ...props }) => <em className="italic" {...props} />,
                }}
            >
                {processedContent}
            </ReactMarkdown>
        </div>
    );
}
