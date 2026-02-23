"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, Shield, User } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type VoiceProfile = {
  tone: string | null;
  persona: string | null;
  writingGuidelines: string | null;
  preferredWords: string[];
  forbiddenWords: string[];
  additionalInstructions: string | null;
};

type ProfileFormState = {
  tone: string;
  persona: string;
  writingGuidelines: string;
  preferredWords: string;
  forbiddenWords: string;
  additionalInstructions: string;
};

type MeResponse = {
  userEmail: string;
  profile: VoiceProfile;
  globalProfile: VoiceProfile;
  mergedProfile: VoiceProfile;
  prompt: string;
  error?: string;
};

type GlobalResponse = {
  profile: VoiceProfile;
  canEdit: boolean;
  error?: string;
};

function emptyProfile(): VoiceProfile {
  return {
    tone: null,
    persona: null,
    writingGuidelines: null,
    preferredWords: [],
    forbiddenWords: [],
    additionalInstructions: null,
  };
}

function toFormState(profile: VoiceProfile): ProfileFormState {
  return {
    tone: profile.tone ?? "",
    persona: profile.persona ?? "",
    writingGuidelines: profile.writingGuidelines ?? "",
    preferredWords: profile.preferredWords.join("\n"),
    forbiddenWords: profile.forbiddenWords.join("\n"),
    additionalInstructions: profile.additionalInstructions ?? "",
  };
}

function parseWordList(raw: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];

  for (const part of raw.split(/[\n,;]/g)) {
    const clean = part.trim();
    if (!clean) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    words.push(clean);
  }

  return words;
}

function toPatchPayload(form: ProfileFormState) {
  const tone = form.tone.trim();
  const persona = form.persona.trim();
  const writingGuidelines = form.writingGuidelines.trim();
  const additionalInstructions = form.additionalInstructions.trim();

  return {
    tone: tone || null,
    persona: persona || null,
    writingGuidelines: writingGuidelines || null,
    preferredWords: parseWordList(form.preferredWords),
    forbiddenWords: parseWordList(form.forbiddenWords),
    additionalInstructions: additionalInstructions || null,
  };
}

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  return token;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export function VoicePolicySettings() {
  const token = useAuthToken();

  const [userEmail, setUserEmail] = useState<string>("");
  const [myForm, setMyForm] = useState<ProfileFormState>(() =>
    toFormState(emptyProfile()),
  );
  const [globalForm, setGlobalForm] = useState<ProfileFormState>(() =>
    toFormState(emptyProfile()),
  );
  const [canEditGlobal, setCanEditGlobal] = useState(false);
  const [mergedPrompt, setMergedPrompt] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const [savingMyProfile, setSavingMyProfile] = useState(false);
  const [savingGlobalProfile, setSavingGlobalProfile] = useState(false);

  const [mySuccess, setMySuccess] = useState<string | null>(null);
  const [myError, setMyError] = useState<string | null>(null);
  const [globalSuccess, setGlobalSuccess] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    if (!token) return;

    setLoading(true);
    setLoadingError(null);

    try {
      const [meRes, globalRes] = await Promise.all([
        fetch("/api/voice/me", {
          method: "GET",
          headers: authHeaders(token),
          cache: "no-store",
        }),
        fetch("/api/voice/global", {
          method: "GET",
          headers: authHeaders(token),
          cache: "no-store",
        }),
      ]);

      const meData = (await meRes.json()) as MeResponse;
      const globalData = (await globalRes.json()) as GlobalResponse;

      if (!meRes.ok) {
        throw new Error(meData.error || "Error loading your voice settings.");
      }

      if (!globalRes.ok) {
        throw new Error(globalData.error || "Error loading global voice settings.");
      }

      setUserEmail(meData.userEmail || "");
      setMyForm(toFormState(meData.profile ?? emptyProfile()));
      setGlobalForm(toFormState(globalData.profile ?? emptyProfile()));
      setCanEditGlobal(Boolean(globalData.canEdit));
      setMergedPrompt(meData.prompt || "");
    } catch (error) {
      setLoadingError(
        error instanceof Error ? error.message : "Error loading voice settings.",
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  async function saveMyProfile() {
    if (!token) return;

    setSavingMyProfile(true);
    setMyError(null);
    setMySuccess(null);

    try {
      const response = await fetch("/api/voice/me", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(toPatchPayload(myForm)),
      });

      const data = (await response.json()) as MeResponse;
      if (!response.ok) {
        throw new Error(data.error || "Error saving your profile.");
      }

      setMySuccess("Your profile has been updated.");
      await loadProfiles();
    } catch (error) {
      setMyError(
        error instanceof Error ? error.message : "Error saving your profile.",
      );
    } finally {
      setSavingMyProfile(false);
    }
  }

  async function saveGlobalProfile() {
    if (!token || !canEditGlobal) return;

    setSavingGlobalProfile(true);
    setGlobalError(null);
    setGlobalSuccess(null);

    try {
      const response = await fetch("/api/voice/global", {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(toPatchPayload(globalForm)),
      });

      const data = (await response.json()) as GlobalResponse;
      if (!response.ok) {
        throw new Error(data.error || "Error saving global profile.");
      }

      setGlobalSuccess("Global profile updated.");
      await loadProfiles();
    } catch (error) {
      setGlobalError(
        error instanceof Error ? error.message : "Error saving global profile.",
      );
    } finally {
      setSavingGlobalProfile(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-dvh bg-neutral-950 px-4 py-10 text-neutral-100 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <Card className="border-white/10 bg-neutral-900 text-neutral-100">
            <CardHeader>
              <CardTitle>Voice Policy</CardTitle>
              <CardDescription className="text-neutral-400">
                Waiting for authentication session.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-neutral-950 px-4 py-10 text-neutral-100 sm:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="rounded-full border-white/15 bg-white/[0.03] px-3 py-1 text-xs text-neutral-300"
              >
                Settings
              </Badge>
              <Badge
                variant="outline"
                className="rounded-full border-white/15 bg-white/[0.03] px-3 py-1 text-xs text-neutral-300"
              >
                Voice Policy
              </Badge>
            </div>
            <h1 className="mt-3 text-3xl font-semibold text-white">
              Tone and Writing Policy
            </h1>
            <p className="mt-2 text-sm text-neutral-400">
              Configure brand voice and personal voice. Personal settings override
              tone/persona and are merged with global word rules.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-white/10 bg-white/[0.03] text-neutral-300 hover:bg-white/10 hover:text-white"
            onClick={loadProfiles}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Refreshing
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </>
            )}
          </Button>
        </header>

        {loadingError && (
          <Card className="border-red-500/30 bg-red-500/10">
            <CardContent className="py-4 text-sm text-red-300">
              {loadingError}
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <VoiceCard
            icon={<User className="h-4 w-4" />}
            title="My Voice Profile"
            description="Applied only to your generated content."
            email={userEmail}
            editable={true}
            form={myForm}
            onFormChange={setMyForm}
            saving={savingMyProfile}
            success={mySuccess}
            error={myError}
            saveLabel="Save my profile"
            onSave={saveMyProfile}
          />

          <VoiceCard
            icon={<Shield className="h-4 w-4" />}
            title="Kodus Global Voice"
            description="Default company policy for all users."
            editable={canEditGlobal}
            form={globalForm}
            onFormChange={setGlobalForm}
            saving={savingGlobalProfile}
            success={globalSuccess}
            error={globalError}
            saveLabel="Save global profile"
            onSave={saveGlobalProfile}
            readonlyMessage={!canEditGlobal ? "Read-only: you are not a global voice admin." : null}
          />
        </div>

        <Card className="border-0 bg-neutral-900 shadow-sm ring-1 ring-white/10">
          <CardHeader>
            <CardTitle className="text-lg">Merged Policy Preview</CardTitle>
            <CardDescription className="text-neutral-400">
              This is the exact prompt snippet sent to n8n (`voicePolicy.prompt`).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[280px] overflow-auto rounded-xl border border-white/10 bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-300">
              {mergedPrompt || "No prompt yet."}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function VoiceCard({
  icon,
  title,
  description,
  email,
  editable,
  form,
  onFormChange,
  saving,
  success,
  error,
  saveLabel,
  onSave,
  readonlyMessage,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  email?: string;
  editable: boolean;
  form: ProfileFormState;
  onFormChange: (value: ProfileFormState) => void;
  saving: boolean;
  success: string | null;
  error: string | null;
  saveLabel: string;
  onSave: () => void;
  readonlyMessage?: string | null;
}) {
  return (
    <Card className="border-0 bg-neutral-900 shadow-sm ring-1 ring-white/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {icon}
          {title}
        </CardTitle>
        <CardDescription className="text-neutral-400">
          {description}
          {email ? ` (${email})` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ProfileField
          label="Tone"
          value={form.tone}
          disabled={!editable}
          onChange={(value) => onFormChange({ ...form, tone: value })}
          placeholder="Ex: Technical, direct, no hype"
        />

        <ProfileField
          label="Persona"
          value={form.persona}
          disabled={!editable}
          onChange={(value) => onFormChange({ ...form, persona: value })}
          placeholder="Ex: Senior engineering advisor"
        />

        <ProfileTextArea
          label="Writing Guidelines"
          value={form.writingGuidelines}
          disabled={!editable}
          onChange={(value) => onFormChange({ ...form, writingGuidelines: value })}
          placeholder="Style, structure, audience and clarity rules."
        />

        <ProfileTextArea
          label="Preferred Words/Phrases"
          hint="One per line (or comma-separated)"
          value={form.preferredWords}
          disabled={!editable}
          onChange={(value) => onFormChange({ ...form, preferredWords: value })}
          placeholder="engineering\nreliability\ndelivery"
        />

        <ProfileTextArea
          label="Forbidden Words/Phrases"
          hint="One per line (or comma-separated)"
          value={form.forbiddenWords}
          disabled={!editable}
          onChange={(value) => onFormChange({ ...form, forbiddenWords: value })}
          placeholder="revolutionary\ngame changer"
        />

        <ProfileTextArea
          label="Additional Instructions"
          value={form.additionalInstructions}
          disabled={!editable}
          onChange={(value) =>
            onFormChange({ ...form, additionalInstructions: value })
          }
          placeholder="Extra constraints and preferences."
        />

        {readonlyMessage && (
          <p className="text-xs text-amber-300">{readonlyMessage}</p>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {success && <p className="text-xs text-emerald-400">{success}</p>}

        <Button
          onClick={onSave}
          disabled={!editable || saving}
          className="bg-white text-neutral-900 hover:bg-neutral-200"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {saveLabel}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function ProfileField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <label className="space-y-2 block">
      <span className="text-xs font-medium uppercase text-neutral-500">
        {label}
      </span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="border-white/10 bg-neutral-950 text-neutral-100 placeholder:text-neutral-500"
      />
    </label>
  );
}

function ProfileTextArea({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="space-y-2 block">
      <span className="text-xs font-medium uppercase text-neutral-500">
        {label}
      </span>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="min-h-[92px] border-white/10 bg-neutral-950 text-neutral-100 placeholder:text-neutral-500"
      />
      {hint ? <span className="text-[11px] text-neutral-500">{hint}</span> : null}
    </label>
  );
}
