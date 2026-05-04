'use client';

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import {
  BarChart3,
  Calendar,
  ChevronRight,
  Clock,
  KanbanSquare,
  Lightbulb,
  Loader2,
  LogOut,
  MessageCircle,
  MessageSquare,
  Radar,
  Settings,
  Sparkles,
  Star,
  Wrench,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { AgentChat } from "@/components/agent-chat";
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

type AuthMode = "signin" | "signup" | "forgot";

function getPasswordResetRedirectUrl(): string | undefined {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredUrl) {
    return `${configuredUrl.replace(/\/$/, "")}/reset-password`;
  }

  if (typeof window === "undefined") {
    return undefined;
  }

  return `${window.location.origin}/reset-password`;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const pathname = usePathname();
  const [manualToolParam, setManualToolParam] = useState<string | null>(null);
  const navSections = useMemo(
    () => [
      {
        label: "Workspace",
        items: [
          { href: "/", label: "Content Canvas", icon: Sparkles },
          { href: "/kanban", label: "Kanban", icon: KanbanSquare },
          { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
        ],
      },
      {
        label: "Discovery",
        items: [
          { href: "/social-monitoring", label: "Social Monitor", icon: Radar },
          { href: "/reply-radar", label: "Reply Radar", icon: MessageCircle },
          { href: "/calendario", label: "Calendar", icon: Calendar },
          { href: "/ideas", label: "Ideas", icon: Lightbulb },
        ],
      },
      {
        label: "Production",
        items: [
          { href: "/manual", label: "Manual Mode", icon: Wrench, hasSubmenu: true },
        ],
      },
      {
        label: "Automation",
        items: [
          { href: "/jobs", label: "Scheduled Jobs", icon: Clock },
        ],
      },
      {
        label: "Personal",
        items: [
          { href: "/favoritos", label: "Favorites", icon: Star },
        ],
      },
    ],
    [],
  );
  const manualSubLinks = useMemo(
    () => [
      { href: "/manual", label: "Overview", tool: "all" },
      { href: "/manual?tool=complete", label: "Full flow", tool: "complete" },
      { href: "/manual?tool=reverse", label: "Title → Keywords", tool: "reverse" },
      { href: "/manual?tool=quick", label: "Quick manual", tool: "quick" },
      { href: "/manual?tool=comparison", label: "Comparison", tool: "comparison" },
      { href: "/manual?tool=update", label: "Update article", tool: "update" },
      { href: "/manual?tool=social", label: "Social posts", tool: "social" },
      { href: "/manual?tool=yolo", label: "YOLO queue", tool: "yolo" },
    ],
    [],
  );
  const [agentOpen, setAgentOpen] = useState(false);
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

    if (mode === "forgot") {
      if (!email.trim()) {
        setFormError("Enter your email.");
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (allowedDomain && !normalizedEmail.endsWith(allowedDomain)) {
        setFormError(`Only ${allowedDomain} accounts can reset passwords.`);
        return;
      }

      setSubmitting(true);
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(
          normalizedEmail,
          {
            redirectTo: getPasswordResetRedirectUrl(),
          },
        );
        if (error) {
          throw error;
        }
        setFormMessage(
          "Password reset email sent. Check your inbox and open the link from the same browser.",
        );
      } catch (error) {
        setFormError(
          error instanceof Error
            ? error.message
            : "We couldn't send the reset email.",
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

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
              {mode === "forgot"
                ? "Reset your password"
                : "Sign in to use Copilot"}
            </CardTitle>
            <CardDescription className="text-neutral-400">
              {mode === "forgot"
                ? `Enter your ${allowedDomain} email and we will send a secure reset link.`
                : (
                    <>
                      Use the project&apos;s Supabase credentials. Only emails ending with{" "}
                      {allowedDomain} are allowed. Don&apos;t have an account yet? Ask your
                      team or create one below.
                    </>
                  )}
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
              {mode !== "forgot" ? (
                <Input
                  type="password"
                  placeholder="Senha"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="border-white/10 bg-neutral-900 focus-visible:ring-neutral-200"
                />
              ) : null}
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
                ) : mode === "forgot" ? (
                  "Send reset link"
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
                onClick={() => {
                  setFormError(null);
                  setFormMessage(null);
                  setMode((prev) => (prev === "signin" ? "signup" : "signin"));
                }}
              >
                {mode === "signin" ? "Create an account" : "Back to sign in"}
              </button>
              {mode === "signin" ? (
                <button
                  type="button"
                  className="underline-offset-4 transition hover:text-white hover:underline"
                  onClick={() => {
                    setFormError(null);
                    setFormMessage(null);
                    setPassword("");
                    setMode("forgot");
                  }}
                >
                  Forgot password?
                </button>
              ) : null}
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  const manualSectionActive = pathname === "/manual";
  const activeManualTool = manualSectionActive ? (manualToolParam ?? "all") : null;

  // Find current page label from nav for the topbar breadcrumb.
  const currentNavLabel = useMemo(() => {
    for (const section of navSections) {
      for (const item of section.items) {
        if (item.href === "/" ? pathname === "/" : pathname === item.href) {
          return item.label;
        }
      }
    }
    if (pathname === "/settings") return "Settings";
    if (pathname.startsWith("/manual")) return "Manual Mode";
    return "";
  }, [navSections, pathname]);

  const sidebarItemClass = (active: boolean) =>
    cn(
      "group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
      active
        ? "bg-white/[0.06] text-white"
        : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-100",
    );

  return (
    <div className="flex h-screen min-h-screen overflow-hidden bg-neutral-950 text-neutral-100">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="flex h-full w-60 shrink-0 flex-col border-r border-white/[0.06] bg-neutral-950">
        {/* Logo */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.06] px-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-600 text-[11px] font-bold text-white">
            K
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-white">Kodus</p>
            <p className="truncate text-[10px] text-neutral-500">Growth workspace</p>
          </div>
        </div>

        {/* Nav sections */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {navSections.map((section) => (
            <div key={section.label} className="mb-3 last:mb-0">
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                {section.label}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isManual = item.href === "/manual";
                  const active = isManual
                    ? manualSectionActive
                    : pathname === item.href;
                  return (
                    <div key={item.href}>
                      <Link
                        href={item.href}
                        className={sidebarItemClass(active)}
                      >
                        <Icon
                          className={cn(
                            "size-4 shrink-0",
                            active ? "text-violet-300" : "text-neutral-500 group-hover:text-neutral-300",
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                        {isManual && manualSectionActive && (
                          <ChevronRight className="ml-auto size-3 rotate-90 text-neutral-500" />
                        )}
                      </Link>
                      {/* Manual sub-items, expanded inline when manual is active */}
                      {isManual && manualSectionActive && (
                        <div className="mt-0.5 ml-4 space-y-0.5 border-l border-white/[0.06] pl-2">
                          {manualSubLinks.map((sub) => {
                            const subActive = activeManualTool === sub.tool;
                            return (
                              <Link
                                key={sub.href}
                                href={sub.href}
                                onClick={() => setManualToolParam(sub.tool)}
                                className={cn(
                                  "flex h-7 items-center rounded-md px-2 text-xs transition-colors",
                                  subActive
                                    ? "bg-white/[0.06] text-white"
                                    : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-200",
                                )}
                              >
                                {sub.label}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div className="shrink-0 border-t border-white/[0.06] p-2">
          <Popover>
            <PopoverTrigger asChild>
              <button className="group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm transition hover:bg-white/[0.04]">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-neutral-200">
                  {(session.user.email ?? "?").slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-xs font-medium text-neutral-200">
                    {session.user.email?.split("@")[0]}
                  </p>
                  <p className="truncate text-[10px] text-neutral-500">
                    {session.user.email?.split("@")[1]}
                  </p>
                </div>
                <ChevronRight className="size-3.5 text-neutral-500 group-hover:text-neutral-300" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              className="w-56 border-white/10 bg-neutral-950 p-1 text-neutral-100"
            >
              <Badge
                variant="outline"
                className="mb-1 inline-flex w-full justify-center rounded-md border-white/10 bg-white/[0.03] px-2 py-1.5 text-[11px] text-neutral-400"
              >
                {session.user.email}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-neutral-300 hover:bg-white/10 hover:text-white"
                asChild
              >
                <Link href="/settings">
                  <Settings className="mr-2 size-4" />
                  Settings
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-neutral-300 hover:bg-white/10 hover:text-white"
                onClick={handleSignOut}
              >
                <LogOut className="mr-2 size-4" />
                Sign out
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────── */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* Top bar (slim) */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] bg-neutral-950 px-5">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-neutral-200">
              {currentNavLabel}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAgentOpen((v) => !v)}
              className={cn(
                "h-8 gap-1.5 rounded-md px-2.5 text-xs",
                agentOpen
                  ? "bg-violet-500/15 text-violet-200 hover:bg-violet-500/20"
                  : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200",
              )}
            >
              <MessageSquare className="size-3.5" />
              <span className="hidden sm:inline">Agent</span>
            </Button>
          </div>
        </header>

        {/* Page content */}
        <main className={cn("min-h-0 flex-1 overflow-auto", agentOpen && "mr-[420px]")}>
          {children}
        </main>
      </div>

      {/* ── Agent panel (slide-in right) ─────────────────────────────────── */}
      <div
        className={cn(
          "fixed right-0 top-0 z-30 h-screen w-[420px] border-l border-white/[0.06] bg-neutral-950 transition-transform duration-300",
          agentOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">{agentOpen && <AgentChat compact />}</div>
        </div>
      </div>
    </div>
  );
}
