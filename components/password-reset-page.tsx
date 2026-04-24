"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";

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

function readSupabaseUrlError(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const description =
    hashParams.get("error_description") ??
    searchParams.get("error_description") ??
    hashParams.get("error") ??
    searchParams.get("error");

  return description ? description.replace(/\+/g, " ") : null;
}

export function PasswordResetPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setInitializing(false);
      return;
    }

    const urlError = readSupabaseUrlError();
    if (urlError) {
      setError(urlError);
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setInitializing(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setInitializing(false);
      if (event === "PASSWORD_RECOVERY") {
        setMessage("Choose a new password for your account.");
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setError("Missing Supabase configuration.");
      return;
    }

    setError(null);
    setMessage(null);

    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) {
        throw updateError;
      }

      setPassword("");
      setConfirmPassword("");
      setUpdated(true);
      setMessage("Password updated. You can continue to the app.");
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "We couldn't update your password.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!supabase) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 text-white">
        <Card className="max-w-md border-red-500/20 bg-neutral-900 text-white">
          <CardHeader>
            <CardTitle>Configure Supabase</CardTitle>
            <CardDescription className="text-neutral-300">
              Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
              in `.env.local` to enable password recovery.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 py-12">
      <Card className="w-full max-w-md border-white/10 bg-neutral-950 text-neutral-100 shadow-2xl">
        <CardHeader className="space-y-3">
          <Badge variant="outline" className="w-fit border-white/20">
            Account recovery
          </Badge>
          <CardTitle className="text-2xl font-semibold">
            Set a new password
          </CardTitle>
          <CardDescription className="text-neutral-400">
            Open this page from the reset link Supabase sent to your email.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {initializing ? (
              <div className="flex items-center gap-2 text-sm text-neutral-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Validating reset link...
              </div>
            ) : session ? (
              <>
                <Input
                  type="password"
                  placeholder="New password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="border-white/10 bg-neutral-900 focus-visible:ring-neutral-200"
                  disabled={updated}
                />
                <Input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="border-white/10 bg-neutral-900 focus-visible:ring-neutral-200"
                  disabled={updated}
                />
              </>
            ) : (
              <p className="text-sm text-amber-300">
                This reset link is invalid or expired. Request a new link from
                the sign-in screen.
              </p>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
            {message && <p className="text-sm text-emerald-400">{message}</p>}

            {session && !updated ? (
              <Button
                type="submit"
                className="w-full rounded-2xl bg-white text-neutral-900 hover:bg-neutral-200"
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update password"
                )}
              </Button>
            ) : null}
          </CardContent>

          <CardFooter className="flex flex-col gap-2 text-sm text-neutral-400">
            <Button
              type="button"
              variant="ghost"
              className="text-neutral-300 hover:bg-white/10 hover:text-white"
              asChild
            >
              <Link href="/">{updated ? "Continue to app" : "Back to sign in"}</Link>
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
