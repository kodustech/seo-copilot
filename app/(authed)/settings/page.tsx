import { Suspense } from "react";

import { McpTokenSettings } from "@/components/mcp-token-settings";
import { OutreachMailboxSettings } from "@/components/outreach-mailbox-settings";
import { VoicePolicySettings } from "@/components/voice-policy-settings";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Outreach mailbox, voice policy, and MCP access for Claude Code /
          Cursor.
        </p>
      </div>
      <Suspense
        fallback={
          <div className="text-sm text-muted-foreground">Loading…</div>
        }
      >
        <OutreachMailboxSettings />
      </Suspense>
      <McpTokenSettings />
      <VoicePolicySettings />
    </div>
  );
}
