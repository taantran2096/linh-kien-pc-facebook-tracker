/* content-post.js — v0.5.1 — Bóc tách bài viết Facebook chuẩn xác
 * Sửa so với v0.5.0:
 * 1. Lỗi lọc NGƯỢC: trước đây bỏ phần trước thanh Thích/Bình luận (nội dung bài) và giữ phần sau (bình luận).
 * 2. Chọn đúng bài theo ID trong URL (trang có thể hiện nhiều bài / bài gợi ý).
 * 3. Chỉ đọc trong khung bài (role="article" ngoài cùng), không lẫn bình luận và sidebar.
 * 4. Chờ nội dung ổn định sau khi bấm "Xem thêm".
 * 5. Gửi kèm key bài để background kiểm tra khớp hàng đợi.
 * 6. Bình luận: chỉ giữ bình luận của CHÍNH người đăng (để nhận biết "đã bán"), không dùng để tách giá.
 */
(async () => {
  if (window.top !== window) return;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const send = (m) => { try { return chrome.runtime.sendMessage(m); } catch (e) { return Promise.resolve(null); } };

  // 1. Xác thực tab có do extension quản lý không
  let info = null;
  for (let i = 0; i < 10; i++) {
    try { info = await chrome.runtime.sendMessage({ type: 'IS_QUEUED' }); } catch (e) { info = null; }
    if (info && info.ok) break;
    if (sessionStorage.getItem('cpt') !== '1' && !/[?&]cpt=1(&|$)/.test(location.search)) return;
    await sleep(800);
  }
  if (!info || !info.ok) return;

  const expectedKey = info.key || '';
  const expectedId = (expectedKey.split('_').pop() || '').replace(/\D/g, '');
  const nodeText = (node) => {
    if (!node) return '';
    const visible = (node.innerText || '').trim();
    if (visible) return visible;
    return (node.textContent || '').replace(/\u00a0/g, ' ').trim();
  };

  // 2. Kiểm tra an toàn: đăng nhập / checkpoint
  const curUrl = location.href.toLowerCase();
  const pageTitle = (document.title || '').toLowerCase();
  const hasArticle = () => !!document.querySelector('[role="article"], [data-pagelet^="FeedUnit_"]');
  const hasLoginForm = !!document.querySelector('form[action*="login"], input[type="password"], #loginform');
  const hasCheckpointForm = !!document.querySelector('#checkpointSubmitButton, [name="checkpoint_data"], [action*="checkpoint"]');
  const isSecurityPath = curUrl.includes('/checkpoint') || curUrl.includes('/login') || curUrl.includes('security_check');
  const isSecurityTitle = pageTitle.includes('checkpoint') || pageTitle.includes('xác minh danh tính') || pageTitle.includes('security check') || pageTitle.includes('log in to facebook') || pageTitle.includes('đăng nhập facebook');

  if ((hasLoginForm && !hasArticle()) || hasCheckpointForm || (isSecurityPath && isSecurityTitle)) {
    send({ type: 'SECURITY_CHECK_DETECTED', reason: 'Phát hiện trang đăng nhập hoặc kiểm tra bảo mật (Checkpoint) Facebook' });
    return;
  }

  // 3. Đợi giao diện bài viết nạp xong
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (hasArticle()) break;
    await sleep(500);
  }

  // 4. Bài bị xóa / không xem được
  const bodyText = document.body ? document.body.innerText : '';
  if (/không (xem|truy cập) được nội dung này|this content isn't available|nội dung này hiện không hiển thị|bài viết này đã bị xóa/i.test(bodyText) && !hasArticle()) {
    send({ type: 'POST_FAILED', reason: 'Bài viết không còn hiển thị hoặc đã bị xóa' });
    return;
  }

  const main = document.querySelector('[role="main"]') || document.body;

  // 5. Chọn ĐÚNG khung bài viết
  const hrefOf = (a) => { let h = a.getAttribute('href') || ''; try { h = decodeURIComponent(h); } catch (e) {} return h; };
  const idRe = expectedId ? new RegExp(`/(?:posts|permalink)/${expectedId}(?:[/?#]|$)|multi_permalinks=${expectedId}|story_fbid=${expectedId}`) : null;
  const ARTICLE_SELECTOR = '[role="article"], [data-pagelet^="FeedUnit_"]';

  function pickPostArticle() {
    const all = [...main.querySelectorAll(ARTICLE_SELECTOR)];
    // Chỉ lấy khung ngoài cùng (bình luận là article lồng bên trong bài)
    const top = all.filter(a => {
      const parent = a.parentElement;
      return !parent || !parent.closest(ARTICLE_SELECTOR);
    });
    if (idRe) {
      const byLink = top.find(a => [...a.querySelectorAll('a[href]')].some(l => idRe.test(hrefOf(l))));
      if (byLink) return byLink;
    }
    // Một số layout mới đặt link bài trong article lồng, không phải container ngoài cùng.
    if (idRe) {
      const link = [...main.querySelectorAll('a[href]')].find(a => idRe.test(hrefOf(a)));
      if (link) {
        let p = link.parentElement;
        for (let i = 0; p && p !== main && i < 12; i++, p = p.parentElement) {
          if (p.matches(ARTICLE_SELECTOR)) return p;
        }
      }
    }
    if (top.length === 1) return top[0];
    if (top.length > 1 && expectedId && location.pathname.includes(expectedId)) return top[0];
    return null;
  }

  let art = pickPostArticle();
  if (!art && !main.querySelector('[role="article"], [data-pagelet^="FeedUnit_"]')) {
    // Không có article (cấu trúc lạ): dùng cả vùng main
    art = main;
  }
  if (!art) {
    send({ type: 'POST_FAILED', reason: 'Không xác định được đúng bài viết (trang hiển thị nhiều bài)' });
    return;
  }

  // Phần tử thuộc riêng khung bài này (không nằm trong bình luận lồng bên trong)
  const own = (sel) => [...art.querySelectorAll(sel)].filter(el => {
    if (art === main) return true;
    const a = el.closest(ARTICLE_SELECTOR);
    return a === art;
  });

  // 6. Giả lập click chuẩn React
  const triggerClick = (target) => {
    if (!target) return;
    try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    const pOpts = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mOpts = { bubbles: true, cancelable: true, view: window, detail: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', pOpts)); } catch (e) {}
    try { target.dispatchEvent(new MouseEvent('mousedown', mOpts)); } catch (e) {}
    try { target.dispatchEvent(new PointerEvent('pointerup', pOpts)); } catch (e) {}
    try { target.dispatchEvent(new MouseEvent('mouseup', mOpts)); } catch (e) {}
    try { target.click(); } catch (e) {}
  };

  const SEE_MORE = /^(?:\.{2,4}|…|\s)*(?:xem thêm|see more|xem tiếp|hiển thị thêm)$/i;
  const clicked = new WeakSet();
  const expandSeeMore = () => {
    let n = 0;
    for (const el of own('[role="button"], span, div')) {
      if (el.children.length > 2 || clicked.has(el)) continue;
      const txt = nodeText(el);
      if (txt.length > 20 || !SEE_MORE.test(txt)) continue;
      const btn = el.closest('[role="button"], [tabindex="0"]') || el;
      if (clicked.has(btn)) continue;
      clicked.add(el); clicked.add(btn);
      triggerClick(btn);
      n++;
    }
    return n;
  };

  // 7. Tìm thanh tương tác (Thích / Bình luận / Chia sẻ) của chính bài này
  const actionRe = /^(thích|like|bình luận|comment|chia sẻ|share)$/i;
  const findBar = () => own('[role="button"], button').find(b => {
    const t = nodeText(b);
    const aria = (b.getAttribute('aria-label') || '').trim();
    return actionRe.test(t) || actionRe.test(aria);
  }) || null;

  const NOISE = /^(thích|like|bình luận|comment|chia sẻ|share|xem thêm|see more|gửi tin nhắn|theo dõi|follow|tham gia|join)$/i;
  const COUNTER = /^[\d.,]+\s*(?:k|tr)?\s*(?:bình luận|lượt chia sẻ|lượt thích|comments?|shares?|likes?)$/i;

  // 8. Bóc tách nội dung bài (CHỈ phần nằm TRƯỚC thanh tương tác)
  function extractPostText() {
    const bar = findBar();
    const beforeBar = (node) => {
      if (!bar) return true;
      const pos = bar.compareDocumentPosition(node);
      if (pos & Node.DOCUMENT_POSITION_CONTAINS) return false;          // node chứa cả thanh tương tác
      return !!(pos & Node.DOCUMENT_POSITION_PRECEDING);                // node nằm trước thanh
    };

    // Ưu tiên: khối nội dung chuẩn của Facebook
    const msgSel = '[data-ad-rendering-role="story_message"], [data-ad-comet-preview="message"], [data-ad-preview="message"], [data-testid="post_message"], [data-testid="post_message_wrapper"]';
    let msgNodes = own(msgSel).filter(n => beforeBar(n));
    msgNodes = msgNodes.filter(n => !msgNodes.some(o => o !== n && o.contains(n)));
    let text = msgNodes.map(nodeText).filter(Boolean).join('\n\n').trim();

    // Dự phòng 1: các khối dir="auto" ngoài cùng trước thanh tương tác
    if (text.length < 5) {
      const paras = [];
      for (const b of own('div[dir="auto"], span[dir="auto"]')) {
        if (!beforeBar(b)) continue;
        if (b.closest('h1, h2, h3, h4, [role="button"], a[role="link"]')) continue;
        const outer = b.parentElement && b.parentElement.closest('[dir="auto"]');
        if (outer && art.contains(outer)) continue;
        const t = nodeText(b);
        if (!t || NOISE.test(t) || COUNTER.test(t)) continue;
        if (!paras.includes(t)) paras.push(t);
      }
      text = paras.join('\n\n').trim();
    }

    // Dự phòng 2: lấy chữ của cả khung bài, cắt tại thanh tương tác
    if (text.length < 5) {
      const lines = nodeText(art).split('\n').map(s => s.trim()).filter(Boolean);
      const cut = lines.findIndex(l => /^(thích|like)$/i.test(l));
      text = (cut > 0 ? lines.slice(0, cut) : lines).join('\n');
    }

    return text
      .replace(/(?:\.{2,4}|…|\s)*(?:xem thêm|see more|xem tiếp|hiển thị thêm)\s*$/gim, '')
      .trim();
  }

  // Mở bung "Xem thêm" rồi chờ nội dung ổn định
  for (let round = 0; round < 3; round++) {
    const c = expandSeeMore();
    if (!c && round > 0) break;
    await sleep(800);
  }
  let postText = extractPostText();
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    if (expandSeeMore()) await sleep(600);
    const again = extractPostText();
    if (again === postText && postText.length >= 5) break;
    postText = again;
  }

  if (postText.length < 3) {
    send({ type: 'POST_FAILED', reason: 'Không đọc được nội dung bài (trống)' });
    return;
  }

  // 9. Tác giả: tiêu đề NẰM TRONG khung bài (không lấy tiêu đề h1 của cả trang / tên nhóm)
  let author = '';
  const hdr = own('h2, h3, h4')[0];
  if (hdr) {
    const aTag = hdr.querySelector('a');
    author = nodeText(aTag || hdr);
  }
  if (!author) {
    const u = own('a[href*="/user/"], a[href*="profile.php"]').find(a => nodeText(a));
    if (u) author = nodeText(u);
  }
  author = author.split('\n')[0].trim();

  // 10. Bình luận của CHÍNH người đăng (để nhận biết "đã bán"/"hết")
  let commentsText = '';
  if (author && art !== main) {
    const nested = [...art.querySelectorAll('[role="article"]')].filter(c => c !== art);
    commentsText = nested
      .map(nodeText)
      .filter(t => t && t.split('\n')[0].trim() === author)
      .slice(0, 10)
      .map(t => t.split('\n').slice(1).join(' ').trim())
      .filter(Boolean)
      .join('\n---\n');
  }

  const imageCount = [...art.querySelectorAll('img')].filter(img => img.naturalWidth > 200).length;

  send({
    type: 'POST_CONTENT',
    key: expectedKey,
    url: location.href,
    postText,
    text: postText,
    commentsText,
    imageCount,
    author
  });
})();
