import { SeoWorkspace, type SeoWorkspaceTab } from "@/components/seo-workspace";
import { SocialGenerator } from "@/components/social-generator";
import { SocialYoloPage } from "@/components/social-yolo-page";

type ManualTool = "all" | "complete" | "reverse" | "quick" | "social" | "yolo";

type ManualPageProps = {
  searchParams: Promise<{ tool?: string | string[] }>;
};

function normalizeTool(value: string | undefined): ManualTool {
  if (value === "complete") return "complete";
  if (value === "reverse") return "reverse";
  if (value === "quick") return "quick";
  if (value === "social") return "social";
  if (value === "yolo") return "yolo";
  return "all";
}

function toolToWorkspaceTab(tool: ManualTool): SeoWorkspaceTab | undefined {
  if (tool === "complete") return "complete";
  if (tool === "reverse") return "reverse";
  if (tool === "quick") return "manual";
  return undefined;
}

export default async function ManualPage({ searchParams }: ManualPageProps) {
  const params = await searchParams;
  const toolParam = Array.isArray(params.tool) ? params.tool[0] : params.tool;
  const tool = normalizeTool(toolParam);

  if (tool === "social") {
    return <SocialGenerator />;
  }
  if (tool === "yolo") {
    return <SocialYoloPage />;
  }

  return (
    <SeoWorkspace
      forcedTab={toolToWorkspaceTab(tool)}
      showTabs={tool === "all"}
    />
  );
}
