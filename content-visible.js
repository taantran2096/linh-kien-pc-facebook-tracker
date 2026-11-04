/* content-visible.js (MAIN world) — chỉ bật cho tab do extension mở (cờ cpt=1).
 * Facebook không render đủ nội dung khi tab ở nền, nên giả lập tab đang hiển thị. */
(() => {
  try {
    if (/[?&]cpt=1(&|$)/.test(location.search)) sessionStorage.setItem('cpt', '1');
    if (sessionStorage.getItem('cpt') !== '1') return;
    const def = (obj, prop, val) => { try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {} };
    def(Document.prototype, 'hidden', false);
    def(Document.prototype, 'visibilityState', 'visible');
    const stop = (e) => e.stopImmediatePropagation();
    document.addEventListener('visibilitychange', stop, true);
    window.addEventListener('blur', stop, true);
    window.addEventListener('pagehide', stop, true);
  } catch (e) {}
})();
