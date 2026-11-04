/* content-notifications.js — v0.5.1 — chạy trên facebook.com/notifications.
 * Chỉ gom các thông báo CHƯA ĐỌC (có chấm xanh) trỏ tới bài viết nhóm.
 * v0.5.1: xác định đúng khối của TỪNG thông báo (trước đây khối bị phình ra làm
 * preview lẫn nội dung thông báo khác → lọc từ khoá / lọc cross-post bị sai). */
(() => {
  const sent = new Set();
  const POST_RE = /\/groups\/[\w.\-]+\/(?:posts|permalink)\/\d+|\/groups\/[\w.\-]+\/?\?[^#]*multi_permalinks=\d+/;
  const MARK_READ = /(đánh dấu là đã đọc|mark as read)/i;     // chỉ xuất hiện ở thông báo chưa đọc
  const MARK_UNREAD = /(đánh dấu là chưa đọc|mark as unread)/i; // chỉ xuất hiện ở thông báo đã đọc
  let timer = null;
  let firstScanDone = false;
  let canDetect = false;   // có nhận ra được trạng thái đọc/chưa đọc trên trang không

  const decode = (h) => { try { return decodeURIComponent(h); } catch (e) { return h; } };
  const keyOf = (href) => {
    const d = decode(href);
    return d.split('?')[0] + (d.match(/multi_permalinks=\d+/) || [''])[0];
  };
  const notifIdOf = (href) => (decode(href).match(/[?&]notif_id=(\d+)/) || [])[1] || '';

  // "Danh tính" của một thông báo: notif_id nếu có, nếu không thì khoá bài viết
  const identOf = (href) => {
    const d = decode(href);
    const nid = notifIdOf(href);
    if (nid) return 'n' + nid;
    if (POST_RE.test(d)) return 'p' + keyOf(href);
    return '';
  };

  // Số thông báo khác nhau nằm trong một phần tử
  function identsIn(el) {
    const s = new Set();
    el.querySelectorAll('a[href]').forEach(x => { const id = identOf(x.href); if (id) s.add(id); });
    return s;
  }

  // Lấy khối chứa đúng MỘT thông báo (lên dần đến khi chạm sang thông báo khác)
  function itemBox(a) {
    const own = identOf(a.href);
    const li = a.closest('[role="listitem"]');
    if (li) {
      const ids = identsIn(li);
      if (ids.size <= 1 || (ids.size === 2 && own && ids.has(own) && [...ids].filter(i => i[0] === 'n').length <= 1)) return li;
    }
    let box = a;
    for (let i = 0; i < 8; i++) {
      const p = box.parentElement;
      if (!p || p === document.body) break;
      const ids = identsIn(p);
      if (own) ids.add(own);
      // Chạm sang thông báo khác → dừng
      const nids = [...ids].filter(x => x[0] === 'n');
      const pids = [...ids].filter(x => x[0] === 'p');
      if (nids.length > 1 || pids.length > 1) break;
      // Khối quá lớn (cả danh sách) → dừng
      if ((p.innerText || '').length > 700) break;
      box = p;
    }
    return box;
  }

  function blueDot(box) {
    const els = box.querySelectorAll('div, span, i');
    for (let i = 0; i < els.length && i < 120; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.width < 6 || r.width > 18 || Math.abs(r.width - r.height) > 2) continue;
      const m = getComputedStyle(els[i]).backgroundColor.match(/\d+/g);
      if (!m) continue;
      const [rr, gg, bb] = m.map(Number);
      if (bb > 200 && rr < 110 && gg > 80 && gg < 190) return true;
    }
    return false;
  }

  function readState(box) {
    const labels = [...box.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') || '');
    if (labels.some(l => MARK_READ.test(l))) return { known: true, unread: true };
    if (labels.some(l => MARK_UNREAD.test(l))) return { known: true, unread: false };
    if (blueDot(box)) return { known: true, unread: true };
    return { known: false, unread: false };
  }

  function cleanPreview(box) {
    return (box.innerText || '')
      .replace(/\s+/g, ' ')
      .replace(/\b(?:Mới|Chưa đọc|Unread)\b\s*$/i, '')
      .trim()
      .slice(0, 300);
  }

  function scan() {
    const found = [];
    const seenKeysThisScan = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!POST_RE.test(decode(href))) return;
      const key = keyOf(href);
      if (sent.has(key) || seenKeysThisScan.has(key)) return;
      seenKeysThisScan.add(key);
      const box = itemBox(a);
      const st = readState(box);
      if (st.known) canDetect = true;
      found.push({ key, href, box, st });
    });

    const items = [];
    for (const f of found) {
      let take;
      if (canDetect) take = f.st.unread;           // chế độ chuẩn: chỉ lấy thông báo chưa đọc
      else take = firstScanDone;                    // không nhận ra trạng thái: chỉ lấy thông báo mới xuất hiện sau khi trang tải
      if (!take) { if (!canDetect) sent.add(f.key); continue; }
      sent.add(f.key);
      const preview = cleanPreview(f.box);
      const g = preview.match(/(?:trong|in)\s+(.+?):/i);
      items.push({ url: f.href, preview, groupName: g ? g[1].trim() : '' });
    }
    firstScanDone = true;
    if (items.length) {
      try { chrome.runtime.sendMessage({ type: 'NOTIF_LINKS', items }); } catch (e) {}
    }
  }

  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 800); })
    .observe(document.body, { childList: true, subtree: true });
  setTimeout(scan, 2500);

  // Cuộn nhẹ định kỳ để Facebook tự động nạp thêm danh sách thông báo phong phú
  setInterval(() => {
    try {
      if (document.body && document.body.scrollHeight > 600) {
        window.scrollBy({ top: 350, behavior: 'smooth' });
        setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 1200);
      }
    } catch (e) {}
  }, 45000);
})();
