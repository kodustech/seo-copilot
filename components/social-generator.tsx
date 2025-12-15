"use client";

import { useEffect, useMemo, useState } from "react";
import { Clipboard, Loader2, RefreshCw, Sparkles, Wand2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type PostIdea = {
  id: string;
  variant: string;
  hook: string;
  content: string;
  cta: string;
  hashtags: string[];
  platform: string;
};

type PlatformConfigForm = {
  id: string;
  platform: string;
  maxLength: string;
  linksPolicy: string;
  ctaStyle: string;
  hashtagsPolicy: string;
  numVariations: number;
};

type FeedPost = {
  id: string;
  title: string;
  link: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
};

const platformOptions = [
  { label: "LinkedIn", value: "LinkedIn" },
  { label: "Instagram", value: "Instagram" },
  { label: "Twitter / X", value: "Twitter" },
];

const FORMATTING_HINT =
  "Separe parágrafos com uma linha em branco e mantenha blocos curtos (máx. 3 frases) para facilitar a leitura nas redes sociais.";

function createConfigId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createPlatformConfig(
  overrides: Partial<Omit<PlatformConfigForm, "id">> & { id?: string } = {},
): PlatformConfigForm {
  return {
    id: overrides.id ?? createConfigId(),
    platform: overrides.platform ?? "LinkedIn",
    maxLength: overrides.maxLength ?? "900",
    linksPolicy:
      overrides.linksPolicy ?? "Sem link no corpo; incentive comentários",
    ctaStyle: overrides.ctaStyle ?? "Soft CTA, convidando para comentar ou salvar",
    hashtagsPolicy: overrides.hashtagsPolicy ?? "Até 3 hashtags relevantes",
    numVariations: overrides.numVariations ?? 3,
  };
}

function getDefaultPlatformConfigs() {
  return [
    createPlatformConfig({
      platform: "LinkedIn",
      maxLength: "900",
      linksPolicy: "Sem link; pedir comentário",
      ctaStyle: "Soft CTA",
    }),
    createPlatformConfig({
      platform: "Twitter",
      maxLength: "500",
      linksPolicy: "Sem link",
      ctaStyle: "Soft CTA",
    }),
  ];
}

export function SocialGenerator() {
  const [baseContent, setBaseContent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tone, setTone] = useState("Conversational, direto");
  const [variationStrategy, setVariationStrategy] = useState(
    "Alterar gancho, formato (carrossel/thread/post curto) e CTA entre as variações."
  );
  const [language, setLanguage] = useState("pt-BR");
  const [platformConfigs, setPlatformConfigs] = useState<PlatformConfigForm[]>(
    () => getDefaultPlatformConfigs()
  );
  const [posts, setPosts] = useState<PostIdea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [selectedFeedId, setSelectedFeedId] = useState("");

  const hasValidPlatform = platformConfigs.some(
    (config) => config.platform.trim().length > 0
  );
  const canGenerate = baseContent.trim().length > 12 && hasValidPlatform && !loading;

  useEffect(() => {
    reloadFeed();
  }, []);

  async function handleGeneratePosts() {
    if (!canGenerate) {
      setError("Adicione ao menos uma ideia base para gerar o post.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const formattedPlatforms = platformConfigs
        .map((config) => {
          const parsedMaxLength = Number(config.maxLength);
          return {
            platform: config.platform.trim(),
            maxLength: Number.isFinite(parsedMaxLength) ? parsedMaxLength : undefined,
            linksPolicy: config.linksPolicy.trim(),
            ctaStyle: config.ctaStyle.trim(),
            hashtagsPolicy: config.hashtagsPolicy.trim(),
            numVariations: config.numVariations,
          };
        })
        .filter((config) => config.platform.length > 0);

      if (!formattedPlatforms.length) {
        throw new Error("Adicione ao menos uma configuração de plataforma.");
      }

      const userInstructions = instructions.trim();
      const payloadInstructions = userInstructions
        ? `${userInstructions}\n\n${FORMATTING_HINT}`
        : FORMATTING_HINT;

      const response = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseContent,
          language,
          tone,
          variationStrategy,
          platformConfigs: formattedPlatforms,
          instructions: payloadInstructions,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Não conseguimos gerar posts agora.");
      }
      const variations =
        (Array.isArray(data?.posts) ? data.posts : Array.isArray(data) ? data : []) ??
        [];

      if (!variations.length) {
        throw new Error("O copiloto não retornou variações.");
      }

      type SocialVariation = {
        variant?: number | string;
        hook?: string;
        post?: string;
        cta?: string;
        hashtags?: unknown[];
        platform?: string;
      };

      const timestamp = Date.now();
      setPosts(
        variations.map((item: SocialVariation, index: number) => {
          const variantLabel =
            typeof item.variant === "number" && Number.isFinite(item.variant)
              ? String(item.variant)
              : item.variant
                ? String(item.variant)
                : String(index + 1);
          const resolvedPlatform =
            (typeof item.platform === "string" && item.platform.trim().length > 0
              ? item.platform.trim()
              : platformConfigs[index % platformConfigs.length]?.platform) ?? "Social";
          return {
            id: `${timestamp}-${index}`,
            variant: variantLabel,
            hook: item.hook || "",
            content: item.post || "",
            cta: item.cta || "",
            hashtags: Array.isArray(item.hashtags)
              ? item.hashtags.map((value) => String(value)).filter(Boolean)
              : [],
            platform: resolvedPlatform,
          };
        })
      );
      setCopiedId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erro inesperado ao gerar posts."
      );
    } finally {
      setLoading(false);
    }
  }

  function formatPostForCopy(post: PostIdea) {
    const sections: string[] = [];
    if (post.hook.trim()) {
      sections.push(post.hook.trim());
    }
    if (post.content.trim()) {
      sections.push(post.content.trim());
    }
    if (post.cta.trim()) {
      sections.push(post.cta.trim());
    }
    if (post.hashtags.length) {
      const normalized = post.hashtags
        .map((tag) => {
          const clean = tag.trim();
          if (!clean) return "";
          const withoutHash = clean.replace(/^#+/, "");
          return `#${withoutHash}`;
        })
        .filter(Boolean)
        .join(" ");
      if (normalized) {
        sections.push(normalized);
      }
    }
    return sections.join("\n\n");
  }

  function copyToClipboard(id: string, content: string) {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => {
        setError("Não foi possível copiar o texto agora.");
      });
  }

  function handleConfigChange(
    id: string,
    updates: Partial<Omit<PlatformConfigForm, "id">>
  ) {
    setPlatformConfigs((prev) =>
      prev.map((config) =>
        config.id === id
          ? {
              ...config,
              ...updates,
            }
          : config
      )
    );
  }

  function handleAddPlatform() {
    setPlatformConfigs((prev) => [...prev, createPlatformConfig()]);
  }

  function handleRemovePlatform(id: string) {
    setPlatformConfigs((prev) =>
      prev.length > 1 ? prev.filter((config) => config.id !== id) : prev
    );
  }

  async function reloadFeed() {
    try {
      setFeedLoading(true);
      setFeedError(null);
      const response = await fetch("/api/feed");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Erro ao buscar posts do blog.");
      }
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      setFeedPosts(posts);
    } catch (err) {
      setFeedError(
        err instanceof Error ? err.message : "Não foi possível buscar o feed agora."
      );
    } finally {
      setFeedLoading(false);
    }
  }

  function handleSelectFeedPost(postId: string) {
    setSelectedFeedId(postId);
    const match = feedPosts.find((post) => post.id === postId);
    if (!match) {
      return;
    }
    const composed = [match.title, match.content || match.excerpt]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    setBaseContent(composed);
  }

  const hasPosts = useMemo(() => posts.length > 0, [posts]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-white px-4 py-10 text-neutral-900 dark:from-neutral-950 dark:to-neutral-900 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">
              Social Media
            </Badge>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Base + instruções → posts prontos
            </p>
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white">
              Gerador rápido de posts para social
            </h1>
            <p className="mt-2 max-w-3xl text-base text-neutral-600 dark:text-neutral-300">
              Cole um conteúdo base, adicione instruções ou tom desejado e
              receba sugestões prontas para LinkedIn, Instagram e X.
            </p>
          </div>
        </header>

        <Card className="border-0 bg-white/80 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">Briefing rápido</CardTitle>
              <CardDescription className="text-base">
                Conteúdo base, tom, regras de plataforma e quantas variações
                quer.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <p className="text-xs uppercase text-neutral-500">
                Conteúdo base
              </p>
              <Textarea
                value={baseContent}
                onChange={(event) => setBaseContent(event.target.value)}
                placeholder="Cole o trecho do artigo, briefing ou ideia central..."
                className="min-h-[160px] resize-none bg-neutral-50/70 text-base dark:bg-neutral-800"
              />
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Select
                  value={selectedFeedId || undefined}
                  onValueChange={handleSelectFeedPost}
                  disabled={feedLoading || feedPosts.length === 0}
                >
                  <SelectTrigger className="bg-neutral-50/70 text-sm dark:bg-neutral-800">
                    <SelectValue placeholder="Ou escolha um post recente do blog" />
                  </SelectTrigger>
                  <SelectContent>
                    {feedPosts.map((post) => (
                      <SelectItem key={post.id} value={post.id}>
                        {post.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-sm"
                  onClick={() => {
                    setSelectedFeedId("");
                    reloadFeed();
                  }}
                  disabled={feedLoading}
                >
                  {feedLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Carregando
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Atualizar feed
                    </>
                  )}
                </Button>
              </div>
              {feedError && (
                <p className="text-xs text-red-500">{feedError}</p>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">Instruções</p>
                <Textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="Tom, público, hashtags, formato curto/longo, emojis permitidos..."
                  className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">
                  Estratégia de variação
                </p>
                <Textarea
                  value={variationStrategy}
                  onChange={(event) => setVariationStrategy(event.target.value)}
                  placeholder="Ex.: variar ganchos, alternar CTA direta x soft, mudar estrutura (bullet x thread x carrossel)..."
                  className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">Idioma</p>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                      <SelectValue placeholder="Idioma" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pt-BR">Português (pt-BR)</SelectItem>
                      <SelectItem value="en-US">Inglês (en-US)</SelectItem>
                      <SelectItem value="es-ES">Espanhol (es-ES)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Tom / Voice
                  </p>
                  <Input
                    value={tone}
                    onChange={(event) => setTone(event.target.value)}
                    placeholder="Ex.: Conversacional e direto"
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
              </div>
            </div>
            <div className="space-y-4 rounded-2xl border border-neutral-200/80 p-4 dark:border-white/10">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase text-neutral-500">
                  Plataformas e regras
                </p>
                <Button variant="ghost" size="sm" onClick={handleAddPlatform}>
                  + Adicionar plataforma
                </Button>
              </div>
              <div className="space-y-4">
                {platformConfigs.map((config, index) => (
                  <div
                    key={config.id}
                    className="rounded-2xl border border-neutral-200/80 p-4 dark:border-white/10"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-100">
                        {`Plataforma #${index + 1}`}
                      </p>
                      {platformConfigs.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemovePlatform(config.id)}
                          className="text-red-500 hover:text-red-600"
                        >
                          <X className="mr-1 h-4 w-4" />
                          Remover
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Plataforma
                        </p>
                        <Select
                          value={config.platform}
                          onValueChange={(value) =>
                            handleConfigChange(config.id, { platform: value })
                          }
                        >
                          <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                            <SelectValue placeholder="Plataforma" />
                          </SelectTrigger>
                          <SelectContent>
                            {platformOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Tamanho máximo
                        </p>
                        <Input
                          type="number"
                          min={40}
                          max={1000}
                          value={config.maxLength}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              maxLength: event.target.value,
                            })
                          }
                          placeholder="Ex.: 260"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Qtd. variações
                        </p>
                        <Input
                          type="number"
                          min={1}
                          max={6}
                          value={config.numVariations}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next)) return;
                            handleConfigChange(config.id, {
                              numVariations: Math.min(6, Math.max(1, Math.round(next))),
                            });
                          }}
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Hashtags
                        </p>
                        <Input
                          value={config.hashtagsPolicy}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              hashtagsPolicy: event.target.value,
                            })
                          }
                          placeholder="Ex.: até 3 hashtags específicas"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Links
                        </p>
                        <Input
                          value={config.linksPolicy}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              linksPolicy: event.target.value,
                            })
                          }
                          placeholder="Ex.: sem links no corpo"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Estilo de CTA
                        </p>
                        <Input
                          value={config.ctaStyle}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              ctaStyle: event.target.value,
                            })
                          }
                          placeholder="Ex.: soft CTA convidando a comentar"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex flex-wrap gap-3">
              <Button
                className="flex-1 min-w-[240px] justify-center rounded-2xl bg-neutral-900 px-6 py-6 text-base font-medium hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
                onClick={handleGeneratePosts}
                disabled={!canGenerate}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                    Gerando posts...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-3 h-5 w-5" />
                    Gerar posts sociais
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                className="rounded-2xl px-6 py-6 text-base font-medium"
                onClick={() => {
                  setBaseContent("");
                  setSelectedFeedId("");
                  setInstructions("");
                  setTone("Conversational, direto");
                  setVariationStrategy(
                    "Alterar gancho, formato (carrossel/thread/post curto) e CTA entre as variações."
                  );
                  setLanguage("pt-BR");
                  setPlatformConfigs(getDefaultPlatformConfigs());
                  setPosts([]);
                  setError(null);
                  setFeedError(null);
                }}
                type="button"
              >
                Limpar campos
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">Posts sugeridos</CardTitle>
              <CardDescription className="text-base">
                Copie e ajuste antes de publicar.
              </CardDescription>
            </div>
            <Badge className="rounded-full px-4 py-1 text-sm" variant="outline">
              {hasPosts ? `${posts.length} variações` : "Aguardando briefing"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasPosts ? (
              <div className="rounded-3xl border border-dashed border-neutral-300/70 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                Gere posts a partir do briefing acima para ver as sugestões
                aqui.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                {posts.map((post) => (
                  <div
                    key={post.id}
                    className="flex flex-col gap-3 rounded-2xl border border-neutral-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-neutral-950/40"
                  >
                    <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
                      <Wand2 className="h-4 w-4" />
                      <span>
                        {post.platform} • Var #{post.variant}
                      </span>
                    </div>
                    {post.hook && (
                      <p className="text-sm font-semibold text-neutral-900 dark:text-white">
                        {post.hook}
                      </p>
                    )}
                    <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                      {post.content}
                    </p>
                    {post.cta && (
                      <p className="text-sm text-neutral-700 dark:text-neutral-300">
                        <span className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
                          CTA:&nbsp;
                        </span>
                        {post.cta}
                      </p>
                    )}
                    {post.hashtags.length > 0 && (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        {post.hashtags
                          .map((tag) => {
                            const clean = tag.trim();
                            if (!clean) return "";
                            const withoutHash = clean.replace(/^#+/, "");
                            return `#${withoutHash}`;
                          })
                          .filter(Boolean)
                          .join(" ")}
                      </p>
                    )}
                    <Separator />
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-3 py-2 text-xs"
                        onClick={() =>
                          copyToClipboard(post.id, formatPostForCopy(post))
                        }
                      >
                        <Clipboard className="mr-2 h-4 w-4" />
                        {copiedId === post.id ? "Copiado!" : "Copiar"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
