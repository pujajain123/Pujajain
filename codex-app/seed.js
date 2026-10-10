// First-run preload: if this browser has no saved workspace yet, start from the exported snapshot
// instead of the built-in sample data. Existing browser data is never overwritten.
(function () {
  var seed = window.UMAMI_SEED;
  if (!seed) return;
  try {
    if (!localStorage.getItem('umami-ops-v1')) localStorage.setItem('umami-ops-v1', JSON.stringify(seed.ordersAndOperations));
    if (!localStorage.getItem('umami-production-tracker-v1')) localStorage.setItem('umami-production-tracker-v1', JSON.stringify(seed.productionTracker));
  } catch (e) {
    /* storage unavailable (private window): the dashboard falls back to its built-in data */
  }
})();
