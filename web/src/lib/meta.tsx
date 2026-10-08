import { createContext, useContext, type ReactNode } from 'react';
import { useApi } from './live';

export interface Meta {
  today: string;
  stages: { key: string; label: string; sequence: number; description: string | null; target_days: number | null }[];
  processes: { id: number; key: string; name: string; sequence: number; material_category: string | null; fields: FieldDef[] }[];
  products: { id: number; sku: string; name: string; category: string; default_dimensions: string | null; processes: { process_id: number; material_per_unit: number | null }[] }[];
  customers: { id: number; name: string; contact_person: string | null; phone: string | null; email: string | null; address: string | null; city: string | null; gstin: string | null; notes: string | null }[];
  staff: { id: number; name: string; email: string; phone: string | null; role: string; primary_process_id: number | null; active: number }[];
  materials: { id: number; code: string; name: string; category: string; unit: string; color: string | null; variant: string | null }[];
  settings: Record<string, string>;
}
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'date';
  options?: string[];
  unit?: string;
  section?: string;
}

const Ctx = createContext<{ meta: Meta | undefined; reload: () => void }>({ meta: undefined, reload: () => {} });

export function MetaProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<Meta>('/meta', ['meta', 'staff']);
  return <Ctx.Provider value={{ meta: data, reload }}>{children}</Ctx.Provider>;
}
export const useMeta = () => useContext(Ctx).meta!;
export const useMetaReload = () => useContext(Ctx).reload;
export const useStageLabel = () => {
  const m = useContext(Ctx).meta;
  return (k: string) => m?.stages.find((s) => s.key === k)?.label ?? k;
};
