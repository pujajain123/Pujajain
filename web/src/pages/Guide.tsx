import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { PageHead } from '../components/ui';
import { DEMO } from '../lib/env';

/** Operations guide — how admins and staff use the system day to day. */
export function Guide() {
  const step = (title: string, body: React.ReactNode) => (
    <li>
      <strong>{title}</strong>
      <p>{body}</p>
    </li>
  );
  return (
    <>
      <PageHead eyebrow="Help center" title="Operations guide" sub="A practical walkthrough for managing orders from intake through delivery." />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <section className="card card-pad guide-card">
          <div className="eyebrow">Admin · order lifecycle</div>
          <h2>Run an order from start to finish</h2>
          <ol className="guide-steps">
            {step('Create the order', <>Open <Link to="/orders/new">New order</Link>. Add the client, then one product line per SKU with its frame, powder, rope and fabric details. Add a clear product photo so the team can identify its design and finish.</>)}
            {step('Plan production', <>Each product line gets a job sheet per process — iron, rope, fabric, tile. Check <Link to="/production">Master production</Link> for material readiness and assign staff with due dates in <Link to="/jobs">Job sheets</Link>.</>)}
            {step('Track materials', <>Mark metal, rope, fabric, foam and tile as received in Master production. Rope and fabric stock lives in <Link to="/inventory">Inventory</Link>; every issue, purchase and wastage is a recorded movement.</>)}
            {step('Follow progress and QC', <>Staff record units and steps; each step is inspected before the next one starts. The order moves to Quality check by itself when every job sheet is complete.</>)}
            {step('Dispatch and close', <>Record the final quality check, then carrier and tracking in <Link to="/dispatch">Dispatch</Link>. Mark the order completed once the client confirms delivery. <Link to="/reports">Reports</Link> and the <Link to="/activity">Activity log</Link> show who did what, and when.</>)}
          </ol>
        </section>
        <section className="card card-pad guide-card">
          <div className="eyebrow">Staff · your work</div>
          <h2>Update your assigned jobs</h2>
          <ol className="guide-steps">
            {step('Open your dashboard', 'It lists the jobs assigned to you, what is late, and inspections waiting on you.')}
            {step('Open the job sheet', 'See the order, product details, quantity, due date, material and the production steps.')}
            {step('Work through the steps', 'Press Start step when you begin, Mark done when finished, then Approve or Reject its inspection. A step stays locked until the inspection before it is approved.')}
            {step('Record units and material', 'Enter units finished and rope or fabric used, add a note, and press Save update. The order, stock and admin dashboard update automatically.')}
            {step('Add a product photo', 'On the job sheet or order, add a reference photo so everyone can confirm the product, colour and finish.')}
          </ol>
          <div className="guide-callout">
            <strong>Shortcuts</strong>
            <div className="row wrap gap-16 mt-8">
              <Link to="/my-jobs" className="link">My jobs <ArrowRight size={14} /></Link>
              <Link to="/jobs" className="link">Job sheets <ArrowRight size={14} /></Link>
              <Link to="/inventory" className="link">Inventory <ArrowRight size={14} /></Link>
            </div>
          </div>
        </section>
        <section className="card card-pad guide-card span-2">
          <div className="eyebrow">Workspace data</div>
          <h2>Where updates are saved</h2>
          <p className="muted" style={{ maxWidth: 760 }}>
            {DEMO
              ? 'This preview runs entirely in your browser: changes are saved in this browser only and are not shared with anyone else. The full version stores everything in one shared database, so every person sees the same live data.'
              : 'Everything is stored in one shared database. Every change is visible to the whole team straight away and recorded in the activity log.'}
          </p>
        </section>
      </div>
    </>
  );
}
