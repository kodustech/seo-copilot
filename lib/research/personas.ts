/**
 * Buyer-persona matching for people enrichment.
 *
 * A table's personas (rubric.default_personas or a per-call override) drive
 * two things: which roles we ask the people providers for, and which returned
 * people we keep. Titles on Brazilian LinkedIn are often in Portuguese
 * ("Sócio-diretor", "Fundador", "Diretor de Tecnologia"), so every persona
 * expands into a PT/EN synonym group before matching.
 *
 * Pure module — no I/O — so it is unit-testable without a database.
 */

/** Synonym groups, all lowercase, accent-free. Order inside a group is the
 *  order we try when searching a provider (most common first). */
const SYNONYM_GROUPS: Record<string, string[]> = {
  founder: [
    "founder",
    "co-founder",
    "cofounder",
    "fundador",
    "fundadora",
    "co-fundador",
    "cofundador",
    "socio fundador",
    "socia fundadora",
    "founding partner",
    "owner",
    "proprietario",
  ],
  ceo: [
    "ceo",
    "chief executive",
    "diretor executivo",
    "diretora executiva",
    "diretor geral",
    "diretor-presidente",
    "presidente",
    "managing director",
  ],
  partner: [
    "socio",
    "socia",
    "partner",
    "socio-diretor",
    "socio diretor",
    "socia-diretora",
    "managing partner",
  ],
  cto: [
    "cto",
    "chief technology",
    "chief technical",
    "diretor de tecnologia",
    "diretora de tecnologia",
    "vp de tecnologia",
    "head de tecnologia",
  ],
  vp_engineering: [
    "vp engineering",
    "vp of engineering",
    "vp eng",
    "vice president of engineering",
    "vice president engineering",
    "vp de engenharia",
    "diretor de engenharia",
    "diretora de engenharia",
    "director of engineering",
    "engineering director",
  ],
  head_of_engineering: [
    "head of engineering",
    "head de engenharia",
    "head engineering",
    "engineering lead",
    "lider de engenharia",
  ],
  engineering_manager: [
    "engineering manager",
    "eng manager",
    "gerente de engenharia",
    "gerente de desenvolvimento",
    "tech manager",
    "development manager",
  ],
  head_of_platform: [
    "head of platform",
    "head de plataforma",
    "platform lead",
    "platform engineering lead",
    "gerente de plataforma",
    "platform manager",
  ],
  head_of_devops: [
    "head of devops",
    "head de devops",
    "devops lead",
    "devops manager",
    "gerente de devops",
    "head of sre",
    "head de sre",
    "sre lead",
    "sre manager",
  ],
  qa_lead: [
    "qa lead",
    "head of qa",
    "head de qa",
    "head of quality",
    "head de qualidade",
    "quality lead",
    "lider de qa",
    "gerente de qa",
    "gerente de qualidade",
    "test lead",
    "lider de testes",
    "qa manager",
    "coordenador de qualidade",
    "coordenador de testes",
  ],
  sdet: [
    "sdet",
    "qa automation",
    "test automation",
    "engenheiro de testes",
    "engenheira de testes",
    "analista de testes",
    "automacao de testes",
    "qa engineer",
  ],
  head_of_delivery: [
    "head of delivery",
    "head de delivery",
    "delivery director",
    "diretor de delivery",
    "delivery manager",
    "gerente de delivery",
    "coo",
    "chief operating",
    "diretor de operacoes",
    "diretora de operacoes",
    "head de operacoes",
    "head of operations",
    "diretor de projetos",
    "diretora de projetos",
  ],
  commercial_director: [
    "diretor comercial",
    "diretora comercial",
    "socio comercial",
    "head comercial",
    "commercial director",
    "chief commercial",
    "chief revenue",
    "cro",
    "vp sales",
    "vp of sales",
    "head of sales",
    "diretor de negocios",
    "diretora de negocios",
    "business director",
    "diretor de vendas",
  ],
  practice_lead: [
    "practice lead",
    "practice director",
    "head of practice",
    "lider de pratica",
    "gerente de pratica",
    "practice manager",
  ],
  head_of_product: [
    "head of product",
    "head de produto",
    "vp product",
    "vp of product",
    "cpo",
    "chief product",
    "diretor de produto",
    "diretora de produto",
  ],
  security_lead: [
    "head of security",
    "head de seguranca",
    "ciso",
    "chief information security",
    "head of appsec",
    "appsec lead",
    "gerente de seguranca",
    "diretor de seguranca",
  ],
};

/** Lowercase, strip accents, collapse whitespace, trim. */
export function normalizeRole(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_]+/g, " ")
    .trim();
}

/** Word-boundary match for short terms (acronyms such as "cto", "ceo",
 *  "coo"), substring match otherwise. `role` and `term` must be normalized. */
function termHits(role: string, term: string): boolean {
  if (!term) return false;
  if (term.length <= 4) {
    const pattern = new RegExp(
      `(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
    );
    return pattern.test(role);
  }
  return role.includes(term);
}

/** Synonym group ids a persona belongs to. A persona can map to several
 *  groups ("Sócio comercial" → partner + commercial_director). */
function groupsForPersona(persona: string): string[] {
  const p = normalizeRole(persona);
  if (!p) return [];
  const out: string[] = [];
  for (const [id, terms] of Object.entries(SYNONYM_GROUPS)) {
    if (terms.some((t) => t === p || termHits(p, t) || termHits(t, p))) {
      out.push(id);
    }
  }
  return out;
}

/** All normalized terms that count as a hit for this persona: the persona
 *  itself plus every synonym of every group it belongs to. */
export function personaTerms(persona: string): string[] {
  const p = normalizeRole(persona);
  if (!p) return [];
  const terms = new Set<string>([p]);
  for (const id of groupsForPersona(p)) {
    for (const t of SYNONYM_GROUPS[id]) terms.add(t);
  }
  return [...terms];
}

/**
 * Score a title against the personas. 10 for a literal persona hit, 8 for a
 * synonym hit, summed across personas. 0 means "known, and not a persona";
 * callers treat a null/empty role separately (unknown, not rejected).
 */
export function rankPerson(
  role: string | null | undefined,
  personas: string[],
): number {
  const r = normalizeRole(role);
  if (!r) return 0;
  let score = 0;
  for (const persona of personas) {
    const p = normalizeRole(persona);
    if (!p) continue;
    if (termHits(r, p)) {
      score += 10;
      continue;
    }
    if (personaTerms(p).some((t) => t !== p && termHits(r, t))) score += 8;
  }
  return score;
}

export function roleMatchesPersonas(
  role: string | null | undefined,
  personas: string[],
): boolean {
  return rankPerson(role, personas) > 0;
}

/**
 * Roles to send to a people-search provider. Each persona contributes itself
 * plus its first synonym in the other language when it has one, so a search
 * for "Founder" also asks for "fundador". Capped to bound provider credits.
 */
export function expandSearchRoles(
  personas: string[],
  max = 6,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const key = normalizeRole(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s.trim());
  };

  const cleaned = personas.map((p) => p.trim()).filter(Boolean);
  for (const persona of cleaned) push(persona);
  for (const persona of cleaned) {
    if (out.length >= max) break;
    const p = normalizeRole(persona);
    const groups = groupsForPersona(p);
    if (groups.length === 0) continue;
    // First synonym that looks like the other language: cheap heuristic —
    // pick the first term that neither contains nor is contained by the
    // persona and shares no word with it ("co-founder" is skipped for
    // "founder"; "fundador" is taken).
    const personaWords = new Set(p.split(" "));
    const alt = SYNONYM_GROUPS[groups[0]].find(
      (t) =>
        t !== p &&
        !t.includes(p) &&
        !p.includes(t) &&
        !t.split(/[\s-]+/).some((w) => personaWords.has(w)),
    );
    if (alt) push(alt);
  }
  return out.slice(0, max);
}

/** Stable short tag for cache keys so a persona change invalidates cached
 *  people for the same domain. */
export function personasCacheTag(personas: string[]): string {
  const norm = [...new Set(personas.map(normalizeRole).filter(Boolean))]
    .sort()
    .join("|");
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Known group ids, exported for UI hints/tests. */
export const PERSONA_GROUP_IDS = Object.keys(SYNONYM_GROUPS);
