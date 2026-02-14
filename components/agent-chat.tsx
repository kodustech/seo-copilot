"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Loader2, AlertCircle, RotateCcw, User, Search, FileText, Share2, ArrowUp, BarChart3 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToolResultRenderer } from "@/components/agent-tool-results";

const SUGGESTION_CATEGORIES = [
  {
    label: "SEO",
    icon: Search,
    prompts: [
      "Pesquisar keywords sobre DevOps",
      "Analisar competidores no meu nicho",
    ],
  },
  {
    label: "Content",
    icon: FileText,
    prompts: [
      "Gerar um artigo completo do zero",
      "Sugerir ideias de conteúdo sobre DevOps",
    ],
  },
  {
    label: "Social",
    icon: Share2,
    prompts: [
      "Criar posts sociais a partir do ultimo blog post",
      "Adaptar artigo para LinkedIn",
    ],
  },
  {
    label: "Analytics",
    icon: BarChart3,
    prompts: [
      "Como está a performance de busca orgânica?",
      "Compare esse mês com o anterior",
    ],
  },
];

function AtlasAvatar({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "h-7 w-7 text-xs",
    md: "h-10 w-10 text-base",
    lg: "h-16 w-16 text-2xl",
  };
  return (
    <div
      className={`${sizeClasses[size]} flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 font-semibold text-white shadow-lg shadow-violet-500/20`}
    >
      A
    </div>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <pre className="my-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-sm text-neutral-200 shadow-sm">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm font-mono text-violet-300">
        {children}
      </code>
    );
  },
  h1: ({ children }) => <h3 className="mb-2 mt-3 text-base font-bold text-white first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-2 mt-3 text-base font-bold text-white first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-2.5 text-sm font-bold text-white first:mt-0">{children}</h4>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-white/10 bg-white/[0.04]">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-2 text-left text-xs font-medium text-neutral-400">{children}</th>,
  td: ({ children }) => <td className="border-t border-white/[0.06] px-3 py-2 text-neutral-300">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-violet-400 underline underline-offset-2 hover:text-violet-300">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-violet-500/30 pl-3 text-neutral-400 italic">{children}</blockquote>
  ),
};

function isToolPart(part: { type: string }): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function getToolInfo(part: Record<string, unknown>) {
  const toolName = part.type === "dynamic-tool"
    ? (part.toolName as string)
    : (part.type as string).replace("tool-", "");
  return {
    toolName,
    toolCallId: part.toolCallId as string,
    state: part.state as string,
    input: (part.input as Record<string, unknown>) ?? {},
    output: part.state === "output-available" ? (part.output as Record<string, unknown>) : undefined,
  };
}

export function AgentChat() {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user?.email ?? null);
    });
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        body: { userEmail },
      }),
    [userEmail],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    regenerate,
    clearError,
  } = useChat({ transport });

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isLoading = status === "submitted" || status === "streaming";

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage({ text });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleSuggestion(prompt: string) {
    setInput(prompt);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const isEmpty = messages.length === 0;

  const hasActiveToolLoading = messages.some((m) =>
    m.parts?.some(
      (p) =>
        isToolPart(p as { type: string }) &&
        (p as Record<string, unknown>).state !== "output-available" &&
        (p as Record<string, unknown>).state !== "output-error",
    ),
  );

  return (
    <div className="flex h-[calc(100dvh-73px)] flex-col bg-neutral-950">
      {/* Header — Dark premium */}
      <div className="border-b border-white/[0.06] bg-neutral-950">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
          <div className="relative">
            <AtlasAvatar size="md" />
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-neutral-950 bg-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-white">Atlas</h1>
              <Badge className="border-0 bg-white/[0.06] text-[10px] font-medium text-neutral-400 hover:bg-white/[0.08]">
                CMO Agent
              </Badge>
            </div>
            <p className="text-xs text-neutral-500">Chief Marketing Officer</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Online
          </div>
        </div>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-neutral-900">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-8 px-6">
            {/* Persona */}
            <div className="flex flex-col items-center text-center">
              <div className="mb-4">
                <AtlasAvatar size="lg" />
              </div>
              <h2 className="text-xl font-semibold text-white">Atlas</h2>
              <p className="mt-1 text-sm text-neutral-400">
                Seu CMO de Growth &amp; SEO
              </p>
              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-neutral-500">
                Pesquiso tendências, crio conteúdo e impulsiono seu crescimento
                orgânico.
              </p>
            </div>

            {/* Suggestion categories */}
            <div className="grid w-full max-w-3xl grid-cols-4 gap-3">
              {SUGGESTION_CATEGORIES.map((cat) => {
                const CatIcon = cat.icon;
                return (
                  <div
                    key={cat.label}
                    className="flex flex-col gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10">
                        <CatIcon className="h-3.5 w-3.5 text-violet-400" />
                      </span>
                      <span className="text-xs font-semibold text-neutral-300">
                        {cat.label}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {cat.prompts.map((prompt) => (
                        <button
                          key={prompt}
                          onClick={() => handleSuggestion(prompt)}
                          className="rounded-lg bg-white/[0.04] px-3 py-2 text-left text-[13px] text-neutral-400 transition hover:bg-violet-500/10 hover:text-violet-300"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-1 px-6 py-4">
            {messages.map((message) => {
              const isUser = message.role === "user";

              if (isUser) {
                return (
                  <div key={message.id} className="flex justify-end py-2">
                    <div className="flex max-w-[75%] items-start gap-2.5">
                      <div className="rounded-2xl rounded-tr-md bg-violet-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
                        {message.parts?.map((part, i) =>
                          part.type === "text" ? (
                            <span key={i}>{part.text}</span>
                          ) : null,
                        )}
                      </div>
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10">
                        <User className="h-3.5 w-3.5 text-neutral-300" />
                      </div>
                    </div>
                  </div>
                );
              }

              // Assistant message
              return (
                <div key={message.id} className="flex gap-2.5 py-2">
                  <AtlasAvatar size="sm" />
                  <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                    {message.parts?.map((part, i) => {
                      if (part.type === "text" && part.text) {
                        return (
                          <div
                            key={i}
                            className="text-sm leading-relaxed text-neutral-200"
                          >
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {part.text}
                            </ReactMarkdown>
                          </div>
                        );
                      }
                      if (isToolPart(part as { type: string })) {
                        const info = getToolInfo(part as Record<string, unknown>);
                        return (
                          <ToolResultRenderer
                            key={info.toolCallId}
                            toolName={info.toolName}
                            state={info.state as "input-streaming" | "input-available" | "output-available" | "output-error"}
                            input={info.input}
                            output={info.output}
                          />
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              );
            })}

            {isLoading && !hasActiveToolLoading && (
              <div className="flex gap-2.5 py-2">
                <AtlasAvatar size="sm" />
                <div className="flex items-center gap-2 pt-1 text-sm text-neutral-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
                  Atlas está pensando...
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mx-auto max-w-4xl px-6">
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <p className="flex-1 text-sm text-red-300">
                Ocorreu um erro. Tente novamente.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearError();
                  regenerate();
                }}
                className="text-red-300 hover:bg-red-500/20 hover:text-red-200"
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Input area — Dark premium */}
      <div className="border-t border-white/[0.06] bg-neutral-950">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <form onSubmit={handleSubmit} className="relative">
            <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.04] transition-all focus-within:border-violet-500/40 focus-within:bg-white/[0.06] focus-within:shadow-[0_0_20px_rgba(139,92,246,0.08)]">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Peça algo ao Atlas..."
                rows={1}
                className="w-full resize-none bg-transparent px-4 pb-12 pt-4 text-sm leading-relaxed text-white placeholder:text-neutral-500 focus:outline-none"
                style={{ minHeight: "56px", maxHeight: "160px" }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
                }}
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <span className="text-[11px] text-neutral-600 select-none">
                  {navigator.platform?.includes("Mac") ? "⌘" : "Ctrl"}+Enter
                </span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isLoading || !input.trim()}
                  className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 p-0 text-white shadow-lg shadow-violet-500/20 transition-all hover:from-violet-500 hover:to-indigo-500 hover:shadow-violet-500/30 disabled:opacity-30 disabled:shadow-none"
                >
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
