'use client';

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Loader2, LogOut } from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const allowedDomain =
  process.env.NEXT_PUBLIC_ALLOWED_DOMAIN?.toLowerCase() || "@kodus.io";

type AuthMode = "signin" | "signup";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setInitializing(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setInitializing(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!session || !supabase) {
      setDomainError(null);
      return;
    }

    const email = session.user.email?.toLowerCase() ?? "";
    if (allowedDomain && !email.endsWith(allowedDomain)) {
      const message = `Somente contas ${allowedDomain} podem acessar.`;
      setDomainError(message);
      supabase.auth.signOut();
    } else {
      setDomainError(null);
    }
  }, [session, supabase]);

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setFormError("Configuração do Supabase ausente.");
      return;
    }

    setFormError(null);
    setFormMessage(null);

    if (!email.trim() || !password.trim()) {
      setFormError("Informe e-mail e senha.");
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          throw error;
        }
        setFormMessage(null);
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) {
          throw error;
        }
        setFormMessage(
          "Conta criada! Se o projeto exigir confirmação, verifique seu e-mail.",
        );
        setMode("signin");
      }
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Não conseguimos autenticar agora.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (!supabase) {
      return;
    }
    await supabase.auth.signOut();
  }

  if (!supabase) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-white">
        <Card className="max-w-md border-red-500/20 bg-neutral-900 text-white">
          <CardHeader>
            <CardTitle>Configure o Supabase</CardTitle>
            <CardDescription className="text-neutral-300">
              Defina `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`
              no `.env.local` para habilitar a autenticação.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (initializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">
        <Loader2 className="h-8 w-8 animate-spin text-neutral-300" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#1c1c1c,_#020202)] px-4 py-12">
        <Card className="w-full max-w-md border-white/10 bg-neutral-950 text-neutral-100 shadow-2xl">
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit border-white/20">
              Acesso restrito
            </Badge>
            <CardTitle className="text-2xl font-semibold">
              Entre para usar o Copiloto
            </CardTitle>
            <CardDescription className="text-neutral-400">
              Use as credenciais do Supabase do projeto. Apenas e-mails{" "}
              {allowedDomain} são aceitos. Ainda não tem conta? Solicite ao time
              ou crie usando o botão abaixo.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleAuth}>
            <CardContent className="space-y-4">
              <Input
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="border-white/10 bg-neutral-900 focus-visible:ring-neutral-200"
              />
              <Input
                type="password"
                placeholder="Senha"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="border-white/10 bg-neutral-900 focus-visible:ring-neutral-200"
              />
              {domainError && (
                <p className="text-sm text-red-400">{domainError}</p>
              )}
              {formError && (
                <p className="text-sm text-red-400">{formError}</p>
              )}
              {formMessage && (
                <p className="text-sm text-emerald-400">{formMessage}</p>
              )}
              <Button
                type="submit"
                className="w-full rounded-2xl bg-white text-neutral-900 hover:bg-neutral-200"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processando...
                  </>
                ) : mode === "signin" ? (
                  "Entrar"
                ) : (
                  "Criar conta"
                )}
              </Button>
            </CardContent>
            <CardFooter className="flex flex-col gap-2 text-sm text-neutral-400">
              <button
                type="button"
                className="underline-offset-4 transition hover:text-white hover:underline"
                onClick={() =>
                  setMode((prev) => (prev === "signin" ? "signup" : "signin"))
                }
              >
                {mode === "signin"
                  ? "Quero criar uma conta"
                  : "Já tenho login"}
              </button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  const userEmail = session.user.email ?? "conta autenticada";
  const displayName =
    session.user.user_metadata?.full_name ||
    session.user.user_metadata?.name ||
    userEmail;

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-20 border-b border-neutral-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              Logado como
            </p>
            <p className="text-sm font-semibold text-neutral-800">
              {displayName}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="rounded-full px-3 py-1">
              {session.user.email}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              onClick={handleSignOut}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sair
            </Button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
