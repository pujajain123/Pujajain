// First-run preload and one-time clean-up of the old sample data in this browser.
// - A new browser starts with an empty workspace; only the imported Master production rows are preloaded.
// - Browsers that already hold the old sample workspace have exactly those sample records removed once:
//   the six sample orders, their sample stock figures, sample ledger entries and sample activity. Anything the team
//   entered themselves is kept, including entries made against a sample order.
(function () {
  var OPS = 'umami-ops-v1', TRACKER = 'umami-production-tracker-v1';
  var seed = window.UMAMI_SEED || {};
  var SAMPLE_ORDERS = { 'UM-1048': 'Casa Forma', 'UM-1047': 'The June House', 'UM-1046': 'Studio North', 'UM-1045': 'Nook & Nest', 'UM-1044': 'Atelier One', 'UM-1043': 'Morrow Living' };
  var SAMPLE_TX = { 'TX-208': 'Cotton rope delivery', 'TX-207': 'Ivory boucle', 'TX-206': 'Arlo side table batch' };
  var SAMPLE_ACTIVITY = [
    '2026-10-08T10:42:00|Amit Shah|JOB-1048-ROP|Rope Work updated to 48%',
    '2026-10-08T09:55:00|Rahul Mehta|JOB-1048-IRN|Iron Work marked completed',
    '2026-10-07T16:20:00|System|UM-1048|Order production progress recalculated',
    '2026-10-07T11:05:00|Shubham Jain|UM-1044|Order marked ready for dispatch'
  ];
  // Stock figures the sample workspace started with (not real counts).
  var SAMPLE_STOCK = { Rope: { opening: 280, incoming: 32, reserved: 152, consumed: 96, wastage: 3, reorder: 70 }, Fabric: { opening: 420, incoming: 75, reserved: 116, consumed: 120, wastage: 4, reorder: 100 } };
  var round = function (n) { return Math.round(n * 1000) / 1000; };

  function clean(db) {
    var isSampleOrder = function (o) { return o && SAMPLE_ORDERS[o.id] === o.client; };
    var removed = { orders: 0, entries: 0, activity: 0 };
    var inv = function (name) { return (db.inventory || []).filter(function (i) { return i.name === name; })[0]; };
    // Sample stock figures and the sample incoming entries that were added to them.
    Object.keys(SAMPLE_STOCK).forEach(function (name) {
      var item = inv(name), base = SAMPLE_STOCK[name];
      if (!item) return;
      ['opening', 'incoming', 'reserved', 'consumed', 'wastage'].forEach(function (k) { item[k] = round((Number(item[k]) || 0) - base[k]); });
      if (Number(item.reorder) === base.reorder) item.reorder = 0;
    });
    db.transactions = (db.transactions || []).filter(function (t) {
      var demo = t.demo === true || /^TX-DEMO-/.test(String(t.id));
      var sample = SAMPLE_TX[t.id] !== undefined && SAMPLE_TX[t.id] === t.notes;
      if (demo && t.material !== 'Rope' && t.type === 'Incoming') { var i = inv(t.material); if (i) i.incoming = round((Number(i.incoming) || 0) - (Number(t.qty) || 0)); }
      if (demo || sample) { removed.entries++; return false; }
      return true;
    });
    db.activity = (db.activity || []).filter(function (a) {
      var key = [a.time, a.actor, a.entity, a.text].join('|');
      if (a.demo === true || String(a.text || '').indexOf('DEMO · ') === 0 || SAMPLE_ACTIVITY.indexOf(key) >= 0) { removed.activity++; return false; }
      return true;
    });
    db.orders = (db.orders || []).filter(function (o) { if (isSampleOrder(o)) { removed.orders++; return false; } return true; });
    if (Array.isArray(db.dispatches)) db.dispatches = db.dispatches.filter(function (d) { return !SAMPLE_ORDERS[d.order]; });
    db.sampleDataRemovedV1 = new Date().toISOString();
    db.sampleDataRemovedCounts = removed;
    return db;
  }

  try {
    var raw = localStorage.getItem(OPS);
    if (raw) {
      var db = JSON.parse(raw);
      if (db && !db.sampleDataRemovedV1) localStorage.setItem(OPS, JSON.stringify(clean(db)));
    }
    if (!localStorage.getItem(TRACKER) && Array.isArray(seed.productionTracker)) localStorage.setItem(TRACKER, JSON.stringify(seed.productionTracker));
  } catch (e) {
    /* storage unavailable (private window): the dashboard starts empty */
  }
})();
