import { NextResponse } from "next/server";

import {
  queryTrafficOverview,
  querySearchPerformance,
  queryTopContent,
  queryComparePerformance,
  queryContentDecay,
  queryContentOpportunities,
} from "@/lib/bigquery";
import { fetchBlogPosts } from "@/lib/copilot";

function periodToDates(period: string): { startDate: string; endDate: string } {
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "30d";
    const { startDate, endDate } = periodToDates(period);

    const [traffic, search, topContent, compare, decay, opportunities, blogPosts] =
      await Promise.all([
        queryTrafficOverview({ startDate, endDate }),
        querySearchPerformance({ startDate, endDate }),
        queryTopContent({ startDate, endDate }),
        queryComparePerformance({ startDate, endDate }),
        queryContentDecay({ startDate, endDate }),
        queryContentOpportunities({ startDate, endDate }),
        fetchBlogPosts(100),
      ]);

    return NextResponse.json({
      period,
      startDate,
      endDate,
      traffic,
      search,
      topContent,
      compare,
      decay,
      opportunities,
      blogPosts,
    });
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json(
      { error: "Error while carregar dados do dashboard." },
      { status: 500 },
    );
  }
}
