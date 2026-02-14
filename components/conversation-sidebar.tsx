"use client";

import { Plus, MessageSquare, Trash2, X, PanelLeft } from "lucide-react";
import type { ConversationSummary } from "@/lib/conversations";

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
};

function groupByDate(conversations: ConversationSummary[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);

  const groups: { label: string; items: ConversationSummary[] }[] = [
    { label: "Hoje", items: [] },
    { label: "Ontem", items: [] },
    { label: "Últimos 7 dias", items: [] },
    { label: "Mais antigos", items: [] },
  ];

  for (const c of conversations) {
    const d = new Date(c.updated_at);
    if (d >= today) groups[0].items.push(c);
    else if (d >= yesterday) groups[1].items.push(c);
    else if (d >= weekAgo) groups[2].items.push(c);
    else groups[3].items.push(c);
  }

  return groups.filter((g) => g.items.length > 0);
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  isOpen,
  onClose,
}: Props) {
  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`fixed left-0 top-0 z-50 flex h-full w-80 flex-col border-r border-white/[0.06] bg-neutral-900 transition-transform duration-200 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-200">Conversas</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onNew}
              className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-white/[0.06] hover:text-white"
              title="Nova conversa"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-neutral-400 transition hover:bg-white/[0.06] hover:text-white"
              title="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-neutral-500">
              Nenhuma conversa ainda
            </p>
          ) : (
            groupByDate(conversations).map((group) => (
              <div key={group.label} className="mb-3">
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                  {group.label}
                </p>
                {group.items.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition ${
                      activeId === c.id
                        ? "bg-violet-500/15 text-violet-300"
                        : "text-neutral-300 hover:bg-white/[0.04]"
                    }`}
                    onClick={() => onSelect(c.id)}
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    <span className="flex-1 truncate text-sm">{c.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                      className="hidden shrink-0 rounded p-1 text-neutral-500 transition hover:bg-red-500/20 hover:text-red-400 group-hover:block"
                      title="Deletar conversa"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

export { PanelLeft as SidebarIcon };
