import { McpTokenSettings } from "@/components/mcp-token-settings";
import { VoicePolicySettings } from "@/components/voice-policy-settings";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Voice policy and MCP access for Claude Code / Cursor.
        </p>
      </div>
      <McpTokenSettings />
      <VoicePolicySettings />
    </div>
  );
}
