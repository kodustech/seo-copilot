"use client";

import { useMemo, useState } from "react";
import { Clipboard, Loader2, Sparkles, Wand2 } from "lucide-react";

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

export function SocialGenerator() {
  const [baseContent, setBaseContent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tone, setTone] = useState("Conversational, direto");
  const [variationStrategy, setVariationStrategy] = useState(
    "Alterar gancho, formato (carrossel/thread/post curto) e CTA entre as variações."
  );
  const [platform, setPlatform] = useState("LinkedIn");
  const [language, setLanguage] = useState("pt-BR");
  const [hashtagsPolicy, setHashtagsPolicy] = useState(
    "Até 3 hashtags relevantes"
  );
  const [linksPolicy, setLinksPolicy] = useState(
    "Sem link no corpo; incentive comentários"
  );
  const [ctaStyle, setCtaStyle] = useState(
    "Soft CTA, convidando para comentar ou salvar"
  );
  const [maxLength, setMaxLength] = useState("260");
  const [numVariations, setNumVariations] = useState(3);
  const [posts, setPosts] = useState<PostIdea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const canGenerate = baseContent.trim().length > 12 && !loading;

  async function handleGeneratePosts() {
    if (!canGenerate) {
      setError("Adicione ao menos uma ideia base para gerar o post.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const parsedMaxLength = Number(maxLength);
      const maxLengthValue = Number.isFinite(parsedMaxLength)
        ? Math.min(1000, Math.max(40, Math.round(parsedMaxLength)))
        : undefined;

      const response = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseContent,
          instructions,
          platform,
          language,
          tone,
          variationStrategy,
          maxLength: maxLengthValue,
          hashtagsPolicy,
          linksPolicy,
          ctaStyle,
          numVariations,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Não conseguimos gerar posts agora.");
      }
      const variations = (Array.isArray(data?.posts) ? data.posts : Array.isArray(data) ? data : []) as {
        variant: number;
        hook: string;
        post: string;
        cta: string;
        hashtags: string[];
      }[];

      if (!variations.length) {
        throw new Error("O copiloto não retornou variações.");
      }

      setPosts(
        variations.map((item, index) => {
          const variantLabel =
            typeof item.variant === "number" && Number.isFinite(item.variant)
              ? String(item.variant)
              : item.variant
                ? String(item.variant)
                : String(index + 1);
          return {
            id: `${Date.now()}-${variantLabel}`,
            variant: variantLabel,
            hook: item.hook || "",
            content: item.post || "",
            cta: item.cta || "",
            hashtags: Array.isArray(item.hashtags)
              ? item.hashtags.map((value) => String(value)).filter(Boolean)
              : [],
            platform,
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
                  <p className="text-xs uppercase text-neutral-500">
                    Plataforma
                  </p>
                  <Select value={platform} onValueChange={setPlatform}>
                    <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                      <SelectValue placeholder="Plataforma" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="LinkedIn">LinkedIn</SelectItem>
                      <SelectItem value="Instagram">Instagram</SelectItem>
                      <SelectItem value="X">Twitter / X</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Qtd. variações
                  </p>
                  <Input
                    type="number"
                    min={1}
                    max={6}
                    value={numVariations}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      setNumVariations(
                        Math.min(6, Math.max(1, Math.round(next)))
                      );
                    }}
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Tamanho máximo
                  </p>
                  <Input
                    type="number"
                    min={40}
                    max={1000}
                    value={maxLength}
                    onChange={(event) => setMaxLength(event.target.value)}
                    placeholder="Ex.: 260"
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">Hashtags</p>
                  <Input
                    value={hashtagsPolicy}
                    onChange={(event) => setHashtagsPolicy(event.target.value)}
                    placeholder="Ex.: Até 3 hashtags, sem genéricas"
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">Links</p>
                  <Input
                    value={linksPolicy}
                    onChange={(event) => setLinksPolicy(event.target.value)}
                    placeholder="Ex.: sem links no corpo; sugerir comentários"
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-neutral-500">
                    Estilo de CTA
                  </p>
                  <Input
                    value={ctaStyle}
                    onChange={(event) => setCtaStyle(event.target.value)}
                    placeholder="Ex.: soft CTA convidando a comentar ou salvar"
                    className="bg-neutral-50/70 dark:bg-neutral-800"
                  />
                </div>
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
                  setInstructions("");
                  setTone("Conversational, direto");
                  setVariationStrategy(
                    "Alterar gancho, formato (carrossel/thread/post curto) e CTA entre as variações."
                  );
                  setPlatform("LinkedIn");
                  setLanguage("pt-BR");
                  setHashtagsPolicy("Até 3 hashtags relevantes");
                  setLinksPolicy("Sem link no corpo; incentive comentários");
                  setCtaStyle("Soft CTA, convidando para comentar ou salvar");
                  setMaxLength("260");
                  setNumVariations(3);
                  setPosts([]);
                  setError(null);
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
                    <Separator />
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-3 py-2 text-xs"
                        onClick={() => copyToClipboard(post.id, post.content)}
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
