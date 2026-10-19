// First-run setup and the one-time reset of this browser's saved workspace.
// A new browser starts with an empty workspace. A browser that already holds data is reset once to zero (below).
(function () {
  var OPS = 'umami-ops-v1', TRACKER = 'umami-production-tracker-v1';
  var seed = window.UMAMI_SEED || {};
  // One-time reset before going live (requested by the owner): no orders, job sheets, ledger, activity or Master
  // production rows, and every stock figure at zero, including each rope in the rope workbook.
  function reset(db) {
    db.orders = []; db.transactions = []; db.activity = []; db.dispatches = [];
    db.inventory = ['Rope', 'Fabric', 'Powder Color'].map(function (name) { return { name: name, unit: name === 'Powder Color' ? 'kg' : 'm', opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 }; });
    db.sampleDataRemovedV1 = db.sampleDataRemovedV1 || new Date().toISOString();
    db.workspaceResetV2 = new Date().toISOString();
    localStorage.setItem(TRACKER, '[]');
    var rope = localStorage.getItem('umami-rope-inventory-v1');
    if (rope) {
      var r = JSON.parse(rope);
      (r.stock_master || []).forEach(function (row) { ['Opening Stock (m)', 'Total Purchased (m)', 'Total Outward (m)', 'Current Balance (m)'].forEach(function (k) { row[k] = '0'; }); });
      r.purchase_log = []; r.outward_log = [];
      localStorage.setItem('umami-rope-inventory-v1', JSON.stringify(r));
    }
    return db;
  }

  try {
    var raw = localStorage.getItem(OPS);
    if (raw) { var current = JSON.parse(raw); if (current && !current.workspaceResetV2) localStorage.setItem(OPS, JSON.stringify(reset(current))); }
    if (!localStorage.getItem(TRACKER) && Array.isArray(seed.productionTracker)) localStorage.setItem(TRACKER, JSON.stringify(seed.productionTracker));
  } catch (e) {
    /* storage unavailable (private window): the dashboard starts empty */
  }
})();
