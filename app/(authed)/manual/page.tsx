"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SeoWorkspace } from "@/components/seo-workspace";
import { SocialGenerator } from "@/components/social-generator";

export default function ManualPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Tabs defaultValue="articles">
        <TabsList>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="social">Social Posts</TabsTrigger>
        </TabsList>
        <TabsContent value="articles">
          <SeoWorkspace />
        </TabsContent>
        <TabsContent value="social">
          <SocialGenerator />
        </TabsContent>
      </Tabs>
    </div>
  );
}
