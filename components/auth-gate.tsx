'use client';

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { ChevronDown, Loader2, LogOut, Settings } from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const allowedDomain =
  process.env.NEXT_PUBLIC_ALLOWED_DOMAIN?.toLowerCase() || "@kodus.io";

type AuthMode = "signin" | "signup";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const pathname = usePathname();
  const [manualToolParam, setManualToolParam] = useState<string | null>(null);
  const primaryLinks = useMemo(
    () => [
      { href: "/", label: "Growth Agent" },
      { href: "/ideias", label: "Ideas Canvas" },
      { href: "/favoritos", label: "Favorites" },
      { href: "/dashboard", label: "Dashboard" },
      { href: "/calendario", label: "Calendar" },
      { href: "/jobs", label: "Scheduled Jobs" },
    ],
    [],
  );
  const manualSubLinks = useMemo(
    () => [
      { href: "/manual", label: "Overview", tool: "all" },
      { href: "/manual?tool=complete", label: "Full flow", tool: "complete" },
      { href: "/manual?tool=reverse", label: "Title → Keywords", tool: "reverse" },
      { href: "/manual?tool=quick", label: "Quick manual", tool: "quick" },
      { href: "/manual?tool=social", label: "Social posts", tool: "social" },
      { href: "/manual?tool=yolo", label: "YOLO queue", tool: "yolo" },
    ],
    [],
  );
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
    if (typeof window === "undefined") {
      return;
    }

    const readQuery = () => {
      const params = new URLSearchParams(window.location.search);
      setManualToolParam(params.get("tool"));
    };

    readQuery();
    window.addEventListener("popstate", readQuery);
    return () => {
      window.removeEventListener("popstate", readQuery);
    };
  }, [pathname]);

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
      const message = `Only ${allowedDomain} accounts can access.`;
      setDomainError(message);
      supabase.auth.signOut();
    } else {
      setDomainError(null);
    }
  }, [session, supabase]);

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setFormError("Missing Supabase configuration.");
      return;
    }

    setFormError(null);
    setFormMessage(null);

    if (!email.trim() || !password.trim()) {
      setFormError("Enter email and password.");
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
          "Account created! If email confirmation is required, check your inbox.",
        );
        setMode("signin");
      }
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "We couldn't autenticar agora.",
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
            <CardTitle>Configure Supabase</CardTitle>
            <CardDescription className="text-neutral-300">
              Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
              in `.env.local` to enable authentication.
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
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 py-12">
        <Card className="w-full max-w-md border-white/10 bg-neutral-950 text-neutral-100 shadow-2xl">
          <CardHeader className="space-y-3">
            <Badge variant="outline" className="w-fit border-white/20">
              Restricted access
            </Badge>
            <CardTitle className="text-2xl font-semibold">
              Sign in to use Copilot
            </CardTitle>
            <CardDescription className="text-neutral-400">
              Use the project&apos;s Supabase credentials. Only emails ending with{" "}
              {allowedDomain} are allowed. Don&apos;t have an account yet? Ask your
              team or create one below.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleAuth}>
            <CardContent className="space-y-4">
              <Input
                type="email"
                placeholder="your@email.com"
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
                  "Sign in"
                ) : (
                  "Create account"
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
                  ? "Create an account"
                  : "I already have an account"}
              </button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  const isDarkPage = true;
  const manualSectionActive = pathname === "/manual";
  const activeManualTool = manualSectionActive ? (manualToolParam ?? "all") : null;
  const allMainLinks = [...primaryLinks, { href: "/manual", label: "Manual Mode" }];

  const headerShellClass = isDarkPage
    ? "border-white/10 bg-neutral-950/95"
    : "border-neutral-200/80 bg-white/95";

  const topNavItemClass = (active: boolean) =>
    cn(
      "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors",
      active
        ? isDarkPage
          ? "bg-white text-neutral-900"
          : "bg-neutral-900 text-white"
        : isDarkPage
          ? "text-neutral-300 hover:bg-white/10 hover:text-white"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
    );

  const manualToolItemClass = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors",
      active
        ? isDarkPage
          ? "bg-neutral-800 text-white"
          : "bg-neutral-900 text-white"
        : isDarkPage
          ? "text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
          : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
    );

  return (
    <div className={cn("min-h-screen", isDarkPage ? "bg-neutral-950" : "bg-neutral-50")}>
      <header className={cn("sticky top-0 z-20 border-b backdrop-blur", headerShellClass)}>
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex h-16 items-center gap-3">
            <div className="min-w-0 shrink-0">
              <p
                className={cn(
                  "text-balance text-sm font-semibold leading-none",
                  isDarkPage ? "text-neutral-200" : "text-neutral-900",
                )}
              >
                SEO Copilot
              </p>
              <p
                className={cn(
                  "mt-1 text-pretty text-xs",
                  isDarkPage ? "text-neutral-500" : "text-neutral-500",
                )}
              >
                Growth workspace
              </p>
            </div>

            <nav className="hidden min-w-0 flex-1 items-center justify-center gap-1 lg:flex">
              {allMainLinks.map((item) => {
                const active = item.href === "/manual"
                  ? manualSectionActive
                  : pathname === item.href;
                return (
                  <Button
                    key={item.href}
                    variant="ghost"
                    size="sm"
                    className={topNavItemClass(active)}
                    asChild
                  >
                    <Link href={item.href}>{item.label}</Link>
                  </Button>
                );
              })}
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 rounded-lg px-3",
                      isDarkPage
                        ? "border-white/10 bg-white/[0.03] text-neutral-300 hover:bg-white/10 hover:text-white"
                        : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100",
                    )}
                  >
                    <span className="hidden max-w-[220px] truncate sm:inline">
                      {session.user.email}
                    </span>
                    <span className="sm:hidden">Account</span>
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className={cn(
                    "w-64 p-2",
                    isDarkPage
                      ? "border-white/10 bg-neutral-950 text-neutral-100"
                      : "border-neutral-200 bg-white text-neutral-900",
                  )}
                >
                  <Badge
                    variant="outline"
                    className={cn(
                      "mb-2 inline-flex w-full justify-center rounded-md px-2 py-1.5 text-xs",
                      isDarkPage
                        ? "border-white/10 bg-white/[0.03] text-neutral-300"
                        : "border-neutral-300 bg-neutral-50 text-neutral-600",
                    )}
                  >
                    {session.user.email}
                  </Badge>

                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "w-full justify-start",
                      isDarkPage
                        ? "text-neutral-300 hover:bg-white/10 hover:text-white"
                        : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
                    )}
                    asChild
                  >
                    <Link href="/settings">
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
                    </Link>
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "w-full justify-start",
                      isDarkPage
                        ? "text-neutral-300 hover:bg-white/10 hover:text-white"
                        : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
                    )}
                    onClick={handleSignOut}
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <nav className="flex items-center gap-1 overflow-x-auto pb-3 lg:hidden [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {allMainLinks.map((item) => {
              const active = item.href === "/manual"
                ? manualSectionActive
                : pathname === item.href;
              return (
                <Button
                  key={`mobile-${item.href}`}
                  variant="ghost"
                  size="sm"
                  className={topNavItemClass(active)}
                  asChild
                >
                  <Link href={item.href}>{item.label}</Link>
                </Button>
              );
            })}
          </nav>

          {manualSectionActive && (
            <div
              className={cn(
                "flex items-center gap-2 border-t py-2",
                isDarkPage ? "border-white/10" : "border-neutral-200",
              )}
            >
              <p
                className={cn(
                  "hidden text-xs font-medium sm:block",
                  isDarkPage ? "text-neutral-500" : "text-neutral-500",
                )}
              >
                Manual tools
              </p>
              <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {manualSubLinks.map((item) => {
                  const active = activeManualTool === item.tool;
                  return (
                    <Button
                      key={item.href}
                      variant="ghost"
                      size="sm"
                      className={manualToolItemClass(active)}
                      asChild
                    >
                      <Link
                        href={item.href}
                        onClick={() => setManualToolParam(item.tool)}
                      >
                        {item.label}
                      </Link>
                    </Button>
                  );
                })}
              </nav>
            </div>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}
