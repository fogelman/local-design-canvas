// Boot: runs last, once every other script has loaded.
// ---------- boot ----------
(async () => {
  setTool("move");
  ME = (await api("/_api/me")).name;
  try { await loadState(); } catch { PAGE = ""; history.replaceState(null, "", location.pathname); await loadState(); }
  restoreView();
  connect();
})();
