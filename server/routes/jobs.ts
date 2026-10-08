import { Router } from 'express';
import { z } from 'zod';
import { JOB_STATUSES } from '../../shared/domain.ts';
import { h, intId, parse } from '../lib.ts';
import { broadcast } from '../live.ts';
import { editJob, jobDetail, listJobs, updateJob } from '../services/jobs.ts';
import { toggleChecklist, updateStep } from '../services/steps.ts';
import { refreshAlerts } from '../services/notifications.ts';

const r = Router();
const changed = () => {
  broadcast('orders', 'jobs', 'inventory', 'dashboard', 'activity');
  void refreshAlerts();
};

r.get(
  '/',
  h((req) => {
    const q = req.query as Record<string, string | undefined>;
    return listJobs({
      q: q.q,
      process: q.process,
      staff: q.mine === '1' ? req.user!.id : q.staff ? Number(q.staff) : undefined,
      status: q.status,
      order: q.order ? Number(q.order) : undefined,
      due: q.due as any,
      includeClosed: q.closed === '1',
    });
  }),
);

r.get('/:id', h((req) => jobDetail(intId(req.params.id))));

const num = z.number().nonnegative().nullish();
r.post(
  '/:id/updates',
  h((req) => {
    const body = parse(
      z.object({
        completed_qty: z.number().int().nonnegative().optional(),
        status: z.enum(JOB_STATUSES).optional(),
        material_used: num,
        wastage: num,
        note: z.string().max(2000).optional(),
        delay_reason: z.string().max(500).optional(),
        specs: z.record(z.any()).optional(),
      }),
      req.body,
    );
    updateJob(intId(req.params.id), { ...body, material_used: body.material_used ?? undefined, wastage: body.wastage ?? undefined }, req.user!);
    changed();
    return jobDetail(intId(req.params.id));
  }),
);

r.patch(
  '/:id',
  h((req) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null));
    const body = parse(
      z.object({
        assigned_to: z.number().int().positive().nullish(),
        start_date: date,
        due_date: date,
        quantity: z.number().int().positive().optional(),
        notes: z.string().max(4000).nullish(),
        qc_remarks: z.string().max(4000).nullish(),
        specs: z.record(z.any()).optional(),
      }),
      req.body,
    );
    editJob(intId(req.params.id), body as any, req.user!);
    changed();
    return jobDetail(intId(req.params.id));
  }),
);

r.post(
  '/:id/steps/:key',
  h((req) => {
    const b = parse(z.object({ status: z.string(), note: z.string().max(1000).nullish() }), req.body);
    updateStep(intId(req.params.id), String(req.params.key), b.status, b.note ?? null, req.user!);
    changed();
    return jobDetail(intId(req.params.id));
  }),
);

r.post(
  '/:id/checklist/:key',
  h((req) => {
    const b = parse(z.object({ done: z.boolean() }), req.body);
    toggleChecklist(intId(req.params.id), String(req.params.key), b.done, req.user!);
    changed();
    return { ok: true };
  }),
);

export default r;
