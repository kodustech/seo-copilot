import { describe, expect, it } from "vitest";

import {
  expandSearchRoles,
  normalizeRole,
  personasCacheTag,
  rankPerson,
  roleMatchesPersonas,
} from "@/lib/research/personas";

describe("research/personas normalizeRole", () => {
  it("lowercases, strips accents and collapses whitespace", () => {
    expect(normalizeRole("  Sócio-Diretor   de  Tecnologia ")).toBe(
      "socio-diretor de tecnologia",
    );
    expect(normalizeRole(null)).toBe("");
  });
});

describe("research/personas rankPerson", () => {
  const partnerPersonas = ["Founder", "CEO", "Sócio comercial", "Head of Delivery"];

  it("hits the literal persona", () => {
    expect(rankPerson("CEO & Co-founder", ["CEO"])).toBeGreaterThan(0);
  });

  it("hits Portuguese synonyms for an English persona", () => {
    expect(roleMatchesPersonas("Fundador e Diretor Executivo", ["Founder"])).toBe(
      true,
    );
    expect(roleMatchesPersonas("Sócio-diretor", partnerPersonas)).toBe(true);
    expect(roleMatchesPersonas("Diretor de Operações", ["Head of Delivery"])).toBe(
      true,
    );
    expect(roleMatchesPersonas("Diretora de Tecnologia", ["CTO"])).toBe(true);
  });

  it("hits English synonyms for a Portuguese persona", () => {
    expect(roleMatchesPersonas("Chief Executive Officer", ["Diretor executivo"])).toBe(
      true,
    );
    expect(roleMatchesPersonas("Co-Founder", ["Fundador"])).toBe(true);
  });

  it("rejects titles that match no persona (the old leak)", () => {
    expect(roleMatchesPersonas("Senior Software Engineer", partnerPersonas)).toBe(
      false,
    );
    expect(roleMatchesPersonas("Analista de Marketing", partnerPersonas)).toBe(false);
    expect(roleMatchesPersonas("Product Manager", ["CTO", "VP Engineering"])).toBe(
      false,
    );
    expect(roleMatchesPersonas("Tech Recruiter", ["Head of Engineering"])).toBe(
      false,
    );
  });

  it("treats short acronyms as whole words", () => {
    // "director" must not match "cto"; "cooperativa" must not match "coo"
    expect(roleMatchesPersonas("Director of Marketing", ["CTO"])).toBe(false);
    expect(roleMatchesPersonas("Gerente na Cooperativa", ["Head of Delivery"])).toBe(
      false,
    );
    expect(roleMatchesPersonas("COO", ["Head of Delivery"])).toBe(true);
    expect(roleMatchesPersonas("CTO at Acme", ["CTO"])).toBe(true);
  });

  it("scores a literal hit above a synonym hit and sums across personas", () => {
    const literal = rankPerson("CEO", ["CEO"]);
    const synonym = rankPerson("Diretor Executivo", ["CEO"]);
    expect(literal).toBeGreaterThan(synonym);
    expect(synonym).toBeGreaterThan(0);
    expect(rankPerson("CEO e Fundador", ["CEO", "Founder"])).toBe(
      rankPerson("CEO", ["CEO"]) + rankPerson("Fundador", ["Founder"]),
    );
  });

  it("returns 0 for an empty title so callers can treat it as unknown", () => {
    expect(rankPerson(null, ["CEO"])).toBe(0);
    expect(rankPerson("   ", ["CEO"])).toBe(0);
  });

  it("still covers the QE rubric personas", () => {
    const qe = [
      "Head of Engineering",
      "Engineering Manager",
      "CTO",
      "VP Engineering",
      "QA Lead",
      "SDET",
      "Founder",
    ];
    expect(roleMatchesPersonas("Gerente de Engenharia", qe)).toBe(true);
    expect(roleMatchesPersonas("Coordenador de Qualidade", qe)).toBe(true);
    expect(roleMatchesPersonas("QA Automation Engineer", qe)).toBe(true);
    expect(roleMatchesPersonas("Diretor de Engenharia", qe)).toBe(true);
    expect(roleMatchesPersonas("Desenvolvedor Backend Pleno", qe)).toBe(false);
  });
});

describe("research/personas expandSearchRoles", () => {
  it("keeps every persona and adds an other-language synonym, capped", () => {
    const roles = expandSearchRoles(["Founder", "Head of Delivery"], 6);
    expect(roles[0]).toBe("Founder");
    expect(roles[1]).toBe("Head of Delivery");
    expect(roles).toContain("fundador");
    expect(roles.length).toBeLessThanOrEqual(6);
  });

  it("dedupes and respects the cap", () => {
    const roles = expandSearchRoles(
      ["CTO", "cto", "Founder", "CEO", "Sócio comercial", "Head of Delivery", "QA Lead"],
      6,
    );
    expect(roles.length).toBe(6);
    expect(new Set(roles.map(normalizeRole)).size).toBe(6);
  });

  it("passes unknown personas through unchanged", () => {
    expect(expandSearchRoles(["Head of Growth"])).toEqual(["Head of Growth"]);
  });
});

describe("research/personas personasCacheTag", () => {
  it("is order- and case-insensitive and changes with the set", () => {
    expect(personasCacheTag(["CEO", "Founder"])).toBe(
      personasCacheTag(["founder", " ceo "]),
    );
    expect(personasCacheTag(["CEO", "Founder"])).not.toBe(
      personasCacheTag(["CTO", "Founder"]),
    );
  });
});
