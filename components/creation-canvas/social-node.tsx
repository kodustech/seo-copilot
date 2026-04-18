"use client";

import { memo, useCallback, type PointerEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Loader2, Copy, Check } from "lucide-react";
import { useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import type { SocialPostVariation } from "@/lib/types";
import type { StepStatus } from "./types";

type SocialNodeData = {
  stepIndex: number;
  socialIndex: number;
  status: StepStatus;
  variation: SocialPostVariation | null;
};

const PLATFORM_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  linkedin: { bg: "bg-blue-600/20", text: "text-blue-300", label: "LinkedIn" },
  twitter: { bg: "bg-sky-500/20", text: "text-sky-300", label: "Twitter/X" },
};

function stopRF(e: PointerEvent) {
  e.stopPropagation();
}

function SocialNodeComponent({ data }: NodeProps) {
  const { status, socialIndex, variation } = data as unknown as SocialNodeData;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!variation) return;
    const text = [variation.hook, variation.post, variation.cta, variation.hashtags.join(" ")]
      .filter(Boolean)
      .join("\n\n");
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [variation]);

  const platform = variation?.platform?.toLowerCase() ?? "";
  const platformStyle = PLATFORM_STYLES[platform] ?? {
    bg: "bg-white/10",
    text: "text-neutral-300",
    label: platform || `Post ${socialIndex + 1}`,
  };

  return (
    <div className="w-[280px] rounded-2xl border border-white/[0.08] bg-neutral-900/90 shadow-xl backdrop-blur">
      <Handle type="target" position={Position.Top} className="!bg-white/20" />

      <div className="p-4">
        {/* Loading */}
        {status === "loading" && (
          <div className="flex flex-col items-center gap-2 py-6">
            <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
            <span className="text-xs text-neutral-500">Generating post {socialIndex + 1}...</span>
          </div>
        )}

        {/* Done */}
        {status === "done" && variation && (
          <>
            {/* Platform badge */}
            <div className="mb-3 flex items-center justify-between">
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${platformStyle.bg} ${platformStyle.text}`}
              >
                {platformStyle.label}
              </span>
              <button
                onPointerDown={stopRF}
                onClick={handleCopy}
                className="rounded-lg p-1.5 text-neutral-500 transition hover:bg-white/10 hover:text-white"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>

            {/* Hook */}
            {variation.hook && (
              <p className="mb-2 text-sm font-semibold leading-snug text-white">
                {variation.hook}
              </p>
            )}

            {/* Post body */}
            <p className="mb-2 line-clamp-4 text-xs leading-relaxed text-neutral-400">
              {variation.post}
            </p>

            {/* CTA */}
            {variation.cta && (
              <p className="mb-2 text-xs font-medium text-violet-400">
                {variation.cta}
              </p>
            )}

            {/* Hashtags */}
            {variation.hashtags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {variation.hashtags.slice(0, 4).map((tag, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-neutral-500"
                  >
                    {tag.startsWith("#") ? tag : `#${tag}`}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const SocialNode = memo(SocialNodeComponent);
