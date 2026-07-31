/**
 * Workspace-level CRM custom properties (Notion-style).
 * Defs live in crm_field_defs; values in crm_companies.properties.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CrmFieldType = "text" | "number" | "boolean" | "select";

export const CRM_FIELD_TYPES: CrmFieldType[] = [
  "text",
  "number",
  "boolean",
  "select",
];

export type CrmFieldOption = {
  id: string;
  label: string;
};

export type CrmFieldDef = {
  id: string;
  key: string;
  label: string;
  type: CrmFieldType;
  options: CrmFieldOption[];
  position: number;
  createdAt: string;
  updatedAt: string;
};

/** Primitive value stored on a company for a custom field. */
export type CrmPropertyValue = string | number | boolean;

export type CrmProperties = Record<string, CrmPropertyValue>;

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

type FieldRow = {
  id: string;
  key: string;
  label: string;
  type: CrmFieldType;
  options: unknown;
  position: number;
  created_at: string;
  updated_at: string;
};

function parseOptions(raw: unknown): CrmFieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: CrmFieldOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!id || !label) continue;
    out.push({ id, label });
  }
  return out;
}

function rowToField(row: FieldRow): CrmFieldDef {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: parseOptions(row.options),
    position: Number(row.position ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Stable slug key from a human label (self_hosted, deployment, …). */
export function fieldKeyFromLabel(label: string): string {
  const raw = label
    .toLowerCase()
    .normalize("NFKD")
    .slice(0, 120);
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0300 && code <= 0x036f) continue;
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
    } else if (out.length > 0 && out[out.length - 1] !== "_") {
      out += "_";
    }
    if (out.length >= 48) break;
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  if (!out || !/^[a-z]/.test(out)) out = `f_${out || "field"}`;
  return out.slice(0, 64);
}

export function isValidFieldKey(key: string): boolean {
  return KEY_RE.test(key);
}

function optionIdFromLabel(label: string): string {
  return fieldKeyFromLabel(label) || "opt";
}

function normalizeOptions(
  type: CrmFieldType,
  options: CrmFieldOption[] | undefined,
): CrmFieldOption[] {
  if (type !== "select") return [];
  const list = options ?? [];
  if (list.length === 0) {
    throw new Error("select fields need at least one option");
  }
  const seen = new Set<string>();
  const out: CrmFieldOption[] = [];
  for (const o of list) {
    const label = (o.label ?? "").trim();
    if (!label) continue;
    let id = (o.id ?? "").trim() || optionIdFromLabel(label);
    if (!isValidFieldKey(id)) id = optionIdFromLabel(label);
    let unique = id;
    let n = 2;
    while (seen.has(unique)) {
      unique = `${id}_${n++}`;
    }
    seen.add(unique);
    out.push({ id: unique, label });
  }
  if (out.length === 0) {
    throw new Error("select fields need at least one option");
  }
  return out;
}

export function coercePropertyValue(
  type: CrmFieldType,
  raw: unknown,
  options?: CrmFieldOption[],
): CrmPropertyValue | null {
  if (raw === null || raw === undefined || raw === "") return null;

  switch (type) {
    case "text": {
      if (typeof raw === "string") return raw;
      if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
      return null;
    }
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string" && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "1" || raw === 1) return true;
      if (raw === "false" || raw === "0" || raw === 0) return false;
      return null;
    }
    case "select": {
      const id = typeof raw === "string" ? raw.trim() : String(raw);
      if (!id) return null;
      if (options && options.length > 0) {
        if (!options.some((o) => o.id === id)) {
          throw new Error(`Invalid select option: ${id}`);
        }
      }
      return id;
    }
    default:
      return null;
  }
}

/** Parse a properties object from DB / API (drop invalid primitives). */
export function normalizeProperties(raw: unknown): CrmProperties {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CrmProperties = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge patch into existing properties.
 * `null` removes a key. Unknown keys allowed (defs may lag); validation optional via defs.
 */
export function mergeProperties(
  existing: CrmProperties,
  patch: Record<string, unknown>,
  defsByKey?: Map<string, CrmFieldDef>,
): CrmProperties {
  const next = { ...existing };
  for (const [key, raw] of Object.entries(patch)) {
    if (!key) continue;
    if (raw === null) {
      delete next[key];
      continue;
    }
    const def = defsByKey?.get(key);
    if (def) {
      const coerced = coercePropertyValue(def.type, raw, def.options);
      if (coerced === null) delete next[key];
      else next[key] = coerced;
    } else if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
    ) {
      next[key] = raw;
    }
  }
  return next;
}

export async function listFieldDefs(
  client: SupabaseClient,
): Promise<CrmFieldDef[]> {
  const { data, error } = await client
    .from("crm_field_defs")
    .select("*")
    .order("position", { ascending: true })
    .order("label", { ascending: true });
  if (error) throw new Error(`Failed to list CRM fields: ${error.message}`);
  return (data ?? []).map((r) => rowToField(r as FieldRow));
}

export async function getFieldDef(
  client: SupabaseClient,
  id: string,
): Promise<CrmFieldDef | null> {
  const { data, error } = await client
    .from("crm_field_defs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to get CRM field: ${error.message}`);
  return data ? rowToField(data as FieldRow) : null;
}

export type CreateFieldDefInput = {
  label: string;
  type: CrmFieldType;
  key?: string;
  options?: CrmFieldOption[];
  position?: number;
};

export async function createFieldDef(
  client: SupabaseClient,
  input: CreateFieldDefInput,
): Promise<CrmFieldDef> {
  const label = (input.label ?? "").trim();
  if (!label) throw new Error("label is required");
  if (!CRM_FIELD_TYPES.includes(input.type)) {
    throw new Error(`Invalid type: ${input.type}`);
  }

  let key = (input.key ?? "").trim() || fieldKeyFromLabel(label);
  if (!isValidFieldKey(key)) {
    throw new Error(
      `Invalid key "${key}". Use lowercase letters, numbers, underscore; start with a letter.`,
    );
  }

  // Ensure unique key
  const { data: clash } = await client
    .from("crm_field_defs")
    .select("id")
    .eq("key", key)
    .maybeSingle();
  if (clash) {
    let n = 2;
    let candidate = `${key}_${n}`;
    while (n < 50) {
      const { data: c2 } = await client
        .from("crm_field_defs")
        .select("id")
        .eq("key", candidate)
        .maybeSingle();
      if (!c2) {
        key = candidate;
        break;
      }
      n += 1;
      candidate = `${key}_${n}`;
    }
  }

  const options = normalizeOptions(input.type, input.options);

  let position = input.position;
  if (position === undefined) {
    const { data: maxRow } = await client
      .from("crm_field_defs")
      .select("position")
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    position = (maxRow?.position != null ? Number(maxRow.position) : -1) + 1;
  }

  const { data, error } = await client
    .from("crm_field_defs")
    .insert({
      key,
      label,
      type: input.type,
      options,
      position,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create CRM field: ${error.message}`);
  return rowToField(data as FieldRow);
}

export type UpdateFieldDefInput = {
  label?: string;
  options?: CrmFieldOption[];
  position?: number;
  /** Type change only allowed when careful; still supported for empty misuse fixes. */
  type?: CrmFieldType;
};

export async function updateFieldDef(
  client: SupabaseClient,
  id: string,
  input: UpdateFieldDefInput,
): Promise<CrmFieldDef> {
  const prev = await getFieldDef(client, id);
  if (!prev) throw new Error("Field not found");

  const patch: Record<string, unknown> = {};
  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label) throw new Error("label cannot be empty");
    patch.label = label;
  }
  if (input.position !== undefined) {
    patch.position = input.position;
  }
  const nextType = input.type ?? prev.type;
  if (input.type !== undefined) {
    if (!CRM_FIELD_TYPES.includes(input.type)) {
      throw new Error(`Invalid type: ${input.type}`);
    }
    patch.type = input.type;
  }
  if (input.options !== undefined || input.type !== undefined) {
    patch.options = normalizeOptions(
      nextType,
      input.options !== undefined ? input.options : prev.options,
    );
  }

  const { data, error } = await client
    .from("crm_field_defs")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update CRM field: ${error.message}`);
  return rowToField(data as FieldRow);
}

export async function deleteFieldDef(
  client: SupabaseClient,
  id: string,
): Promise<{ key: string }> {
  const prev = await getFieldDef(client, id);
  if (!prev) throw new Error("Field not found");

  const { error } = await client.from("crm_field_defs").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete CRM field: ${error.message}`);

  // Orphan values in company.properties are ignored by the UI when def is gone.
  return { key: prev.key };
}

export async function reorderFieldDefs(
  client: SupabaseClient,
  orderedIds: string[],
): Promise<CrmFieldDef[]> {
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await client
      .from("crm_field_defs")
      .update({ position: i })
      .eq("id", orderedIds[i]);
    if (error) throw new Error(`Failed to reorder CRM fields: ${error.message}`);
  }
  return listFieldDefs(client);
}
