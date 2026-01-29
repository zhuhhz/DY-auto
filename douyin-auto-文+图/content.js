(() => {
  /************ 配置 ************/
  let REPLY_TEXT = "你好，已收到你的消息，稍后回复～"; // 可由 popup.js 覆盖
  let REPLY_IMAGE = ""; // 图片路径或URL，可由 popup.js 覆盖
  const TYPE_DELAY = [40, 90];
  const SEND_DELAY = [500, 900];
  const COOLDOWN = 15000;
  const IMAGE_TEXT_INTERVAL = [2000, 4000]; // 图片和文字发送之间的间隔（毫秒）
  /********************************/

  let locked = false;
  let lastSend = 0;
  let enabled = true; // UI toggle (persisted)
  let lastSentText = ''; // 最近发送的消息内容（防重复）
  let lastSentTime = 0; // 最近发送的时间
  let lastSentImage = false; // 最近是否发送了图片（防重复）
  let lastSentImageTime = 0; // 最近发送图片的时间
  let currentChatId = null; // 当前正在处理的会话标识
  const SAME_TEXT_COOLDOWN = 30000; // 相同内容30秒内不重复发送
  const SAME_IMAGE_COOLDOWN = 30000; // 图片30秒内不重复发送
  const EXIT_COOLDOWN = 10000; // 退出会话后10秒可继续回复
  const exitedChats = new Map(); // 存储会话ID和退出时间 { chatId: exitTimestamp }
  const CHAT_REPLY_COOLDOWN = 1000; // 同一会话1秒内只回复一次
  const chatReplyTimes = new Map(); // 存储会话ID和最后回复时间 { chatId: replyTimestamp }
  let checkInterval = null; // 定时检测器
  let panelMinimized = false; // UI面板是否最小化

  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const log = (...a) => console.log("[DY-HUMAN]", ...a);
  log('script loaded');

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** 只取第一句话（按 。！？.!? 或换行分割） */
  function getFirstSentence(s) {
    if (!s || typeof s !== 'string') return '';
    const t = s.trim();
    const first = t.split(/[。！？.!?\n]+/)[0]?.trim();
    return first || t;
  }

  function simulateRealClick(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
      isPrimary: true
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  /* ========= 基础工具 ========= */

  function editorBox() {
    // 优先使用真正 contenteditable 文本框
    const ce = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (ce) return ce;
    const all = [...document.querySelectorAll('div[contenteditable="true"]')];
    if (all.length) return all[all.length - 1];
    return null;
  }

  function getRealSendButton() {
    // 找到红色 path，再向上找到最近的可点击容器（div/button/span）并返回
    const paths = [...document.querySelectorAll('path[fill="#FE2C55"]')];
    for (const p of paths) {
      try {
        const clickable = p.closest('button,div,span');
        if (clickable) {
          const r = clickable.getBoundingClientRect();
          const s = getComputedStyle(clickable);
          if (r.width > 8 && r.height > 8 && s.pointerEvents !== 'none' && s.visibility !== 'hidden') return clickable;
        }
      } catch (e) {}
      let el = p;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width > 20 && r.height > 20 && s.pointerEvents !== "none" && s.visibility !== "hidden") {
          return el;
        }
      }
    }
    return null;
  }

  /** 查找图片发送按钮（专用发送按钮） */
  function findImageSendButton() {
    // 用户提供的图片发送按钮选择器
    const imageSendSelector = '#root > div:nth-child(8) > div > div.uOY2DNgN > div.ekV2gcnW > div.YZOVdiPe';
    try {
      const btn = document.querySelector(imageSendSelector);
      if (btn) {
        const rect = btn.getBoundingClientRect();
        const style = getComputedStyle(btn);
        if (rect.width > 0 && rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none' &&
            style.pointerEvents !== 'none') {
          log('✅ 找到图片发送按钮');
          return btn;
        }
      }
    } catch (e) {
      log('⚠️ 查找图片发送按钮时出错：', e);
    }
    
    // 备用方法：查找包含 YZOVdiPe 类的元素
    try {
      const candidates = document.querySelectorAll('div.YZOVdiPe, .YZOVdiPe');
      for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        if (rect.width > 0 && rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none' &&
            style.pointerEvents !== 'none') {
          // 检查是否在对话框或发送区域内
          const parent = candidate.closest('div.uOY2DNgN, div.ekV2gcnW');
          if (parent) {
            log('✅ 找到图片发送按钮（通过类名）');
            return candidate;
          }
        }
      }
    } catch (e) {}
    
    return null;
  }

  function findRedDotElement() {
    const selectors = [
      '#island_b69f5 span.PygT7Ced.e2e-send-msg-btn',
      '.unread, .badge, .dot, .red-dot, [data-unread], [data-count]'
    ];
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el) return el;
      } catch (e) {}
    }
    
    // 查找红色数字徽章（未读消息标识）
    const all = [...document.querySelectorAll('span,div')];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const bg = style.backgroundColor || '';
      const text = (el.innerText || el.textContent || '').trim();
      
      // 检查是否是红色圆形徽章（包含数字）
      if (r.width > 0 && r.width <= 30 && r.height <= 30 && r.width >= 12 && r.height >= 12) {
        // 检查红色背景
        const isRed = bg.includes('rgb(255,') || bg.includes('#fe2c55') || bg.includes('255, 44, 85') ||
                      bg.includes('rgb(254, 44, 85)') || bg.includes('rgba(254, 44, 85');
        
        // 检查是否包含数字（未读消息数量）
        const hasNumber = /^\d+$/.test(text) && parseInt(text) > 0;
        
        // 检查是否是圆形或接近圆形（宽高比接近1）
        const isRound = Math.abs(r.width - r.height) <= 4;
        
        if (isRed && hasNumber && isRound) {
          log('✅ 找到红色数字徽章（未读消息）：', text);
          return el;
        }
      }
      
      // 兼容旧的小红点查找逻辑
      if (r.width > 0 && r.width <= 18 && r.height <= 18) {
        if (bg.includes('rgb(255,') || bg.includes('#fe2c55')) return el;
      }
    }
    return null;
  }

  async function findRedDotElementAsync() {
    const direct = findRedDotElement();
    if (direct) return direct;
    
    // 查找所有会话列表项
    const list = document.querySelectorAll('#island_b69f5 li, ul li, div[data-uid], [role="listitem"]');
    for (const item of list) {
      try {
        item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      } catch (e) {}
      await sleep(100);
      
      try {
        // 优先查找展开后的元素
        const expanded = item.querySelector('div.J2483ny0.noSemiGlobal span') || 
                        item.querySelector('span.PygT7Ced.e2e-send-msg-btn');
        if (expanded) return expanded;
        
        // 查找红色数字徽章
        const allElements = item.querySelectorAll('span, div');
        for (const el of allElements) {
          if (!item.contains(el)) continue;
          
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const bg = style.backgroundColor || '';
          const text = (el.innerText || el.textContent || '').trim();
          
          // 检查是否是红色数字徽章
          if (r.width > 0 && r.width <= 30 && r.height <= 30 && r.width >= 12 && r.height >= 12) {
            const isRed = bg.includes('rgb(255,') || bg.includes('#fe2c55') || bg.includes('255, 44, 85') ||
                          bg.includes('rgb(254, 44, 85)') || bg.includes('rgba(254, 44, 85');
            const hasNumber = /^\d+$/.test(text) && parseInt(text) > 0;
            const isRound = Math.abs(r.width - r.height) <= 4;
            
            if (isRed && hasNumber && isRound && 
                style.visibility !== 'hidden' && style.display !== 'none') {
              log('✅ findRedDotElementAsync 找到红色数字徽章（未读：' + text + '）');
              return el;
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /** 从会话列表项中提取会话 ID（支持 data-uid、链接 /user/xxx 等） */
  function getChatIdFromItem(item) {
    if (!item) return null;
    const uid = item.getAttribute('data-uid') ||
                item.getAttribute('data-user-id') ||
                (item.querySelector('[data-uid]')?.getAttribute('data-uid'));
    if (uid) return String(uid);
    const link = item.querySelector('a[href*="/user/"]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/\/user\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  /** 将私信列表滚动到顶部，确保「从上到下」顺序与可见一致，便于优先处理最上方未读 */
  function scrollListToTop() {
    const selectors = [
      '#island_b69f5',
      '#island_b69f5 [style*="overflow"]',
      '#island_b69f5 > div > div',
      '[class*="Message"] [style*="overflow"]',
      'ul'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && typeof el.scrollTop === 'number') {
          el.scrollTop = 0;
          log('📜 已滚动私信列表到顶部');
          return;
        }
      } catch (e) {}
    }
  }

  /** 检查会话是否在退出冷却期内（10秒内） */
  function isChatInExitCooldown(chatId) {
    if (!chatId) return false;
    const exitTime = exitedChats.get(String(chatId));
    if (!exitTime) return false;
    const elapsed = Date.now() - exitTime;
    if (elapsed >= EXIT_COOLDOWN) {
      // 超过10秒，清除记录
      exitedChats.delete(String(chatId));
      return false;
    }
    return true;
  }

  /** 检查会话是否在回复冷却期内（1秒内） */
  function isChatInReplyCooldown(chatId) {
    if (!chatId) return false;
    const replyTime = chatReplyTimes.get(String(chatId));
    if (!replyTime) return false;
    const elapsed = Date.now() - replyTime;
    if (elapsed >= CHAT_REPLY_COOLDOWN) {
      // 超过1秒，清除记录
      chatReplyTimes.delete(String(chatId));
      return false;
    }
    return true;
  }

  /** 记录会话的回复时间 */
  function recordChatReply(chatId) {
    if (chatId) {
      chatReplyTimes.set(String(chatId), Date.now());
      log('📝 已记录会话 ' + chatId + ' 的回复时间');
    }
  }

  /** 查找下一个有未读消息的会话（排除已处理的会话，但10秒后可继续回复） */
  async function findNextUnreadChat(excludeChatId = null) {
    try {
      const processedChatId = excludeChatId || currentChatId ? String(excludeChatId || currentChatId) : null;

      scrollListToTop();
      await sleep(150);

      const chatListItems = document.querySelectorAll('#island_b69f5 li, ul li, div[data-uid], [role="listitem"]');
      log('🔍 开始查找下一个有未读消息的会话，当前会话列表项数量：', chatListItems.length, '排除会话ID：', processedChatId || '无');
      
      for (const item of chatListItems) {
        try {
          const itemChatId = getChatIdFromItem(item);
          
          // 如果该会话在退出冷却期内（10秒内），跳过
          if (itemChatId && isChatInExitCooldown(itemChatId)) {
            const exitTime = exitedChats.get(String(itemChatId));
            const remain = Math.ceil((EXIT_COOLDOWN - (Date.now() - exitTime)) / 1000);
            log('⏸️ 会话 ' + itemChatId + ' 在退出冷却期内，还需 ' + remain + ' 秒');
            continue;
          }
          
          // 尝试触发鼠标事件，让未读标识显示
          item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
          item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
          await sleep(80);
          
          // 方法1: 查找红色数字徽章（未读消息数量标识）
          const allElements = item.querySelectorAll('span, div');
          for (const el of allElements) {
            if (!item.contains(el)) continue;
            
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const bg = style.backgroundColor || '';
            const text = (el.innerText || el.textContent || '').trim();
            
            // 检查是否是红色数字徽章
            if (r.width > 0 && r.width <= 30 && r.height <= 30 && r.width >= 12 && r.height >= 12) {
              const isRed = bg.includes('rgb(255,') || bg.includes('#fe2c55') || bg.includes('255, 44, 85') ||
                            bg.includes('rgb(254, 44, 85)') || bg.includes('rgba(254, 44, 85');
              const hasNumber = /^\d+$/.test(text) && parseInt(text) > 0;
              const isRound = Math.abs(r.width - r.height) <= 4;
              
              if (isRed && hasNumber && isRound && 
                  style.visibility !== 'hidden' && style.display !== 'none') {
                log('✅ 找到红色数字徽章（未读：' + text + '），会话ID：', itemChatId || '未知');
                // 返回聊天条目本身，而不是徽章
                return item;
              }
            }
          }
          
          // 方法2: 查找该会话项中的小红点（优先查找该会话项内部的小红点）
          const redDot = item.querySelector('span.PygT7Ced.e2e-send-msg-btn') ||
                        item.querySelector('div.J2483ny0.noSemiGlobal span') ||
                        item.querySelector('span[style*="rgb(255"]') ||
                        item.querySelector('span[style*="#fe2c55"]');
          
          if (redDot && item.contains(redDot)) {
            // 检查小红点是否可见
            const rect = redDot.getBoundingClientRect();
            const style = getComputedStyle(redDot);
            if (rect.width > 0 && rect.height > 0 && 
                style.visibility !== 'hidden' && 
                style.display !== 'none') {
              log('✅ 找到小红点，会话ID：', itemChatId || '未知');
              return item; // 返回聊天条目
            }
          }
          
          // 方法3: 检查该会话项内是否有红色背景的小圆点
          for (const span of allElements) {
            if (!item.contains(span)) continue;
            const r = span.getBoundingClientRect();
            if (r.width > 0 && r.width <= 18 && r.height <= 18) {
              const bg = getComputedStyle(span).backgroundColor || '';
              const fill = span.querySelector('path')?.getAttribute('fill') || '';
              if (bg.includes('rgb(255,') || bg.includes('#fe2c55') || bg.includes('255, 44, 85') ||
                  fill === '#FE2C55' || fill === '#fe2c55') {
                log('✅ 通过背景色/填充色找到未读标识，会话ID：', itemChatId || '未知');
                return item; // 返回聊天条目
              }
            }
          }
        } catch (e) {
          log('⚠️ 检查会话项时出错：', e);
        }
      }
      
      // 如果没找到，尝试直接查找小红点，然后找到其父聊天条目
      const fallbackRedDot = findRedDotElement();
      if (fallbackRedDot) {
        const chatItem = fallbackRedDot.closest('li') || 
                        fallbackRedDot.closest('[data-uid]') ||
                        fallbackRedDot.closest('[role="listitem"]');
        const fallbackChatId = chatItem ? getChatIdFromItem(chatItem) : null;
        // 检查是否在退出冷却期内（10秒内）
        if (fallbackChatId && isChatInExitCooldown(fallbackChatId)) {
          const exitTime = exitedChats.get(String(fallbackChatId));
          const remain = Math.ceil((EXIT_COOLDOWN - (Date.now() - exitTime)) / 1000);
          log('⚠️ fallback 小红点属于刚退出的会话（还需 ' + remain + ' 秒），已排除，避免重复进入');
          return null;
        }
        if (chatItem) {
          log('✅ 通过fallback找到小红点，会话ID：', fallbackChatId || '未知');
          return chatItem;
        }
        return fallbackRedDot;
      }
      
      log('ℹ️ 未找到其他有未读消息的会话');
      return null;
    } catch (e) {
      log('❌ 查找下一个未读会话时出错：', e);
      return null;
    }
  }

  const humanClick = simulateRealClick;

  async function humanType(text, targetEl) {
    const el = targetEl || editorBox();
    if (!el) return false;

    el.focus();

    for (const ch of text) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ch);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: ch
        })
      );
      await sleep(rand(...TYPE_DELAY));
    }
    return true;
  }

  /** 获取当前会话的唯一标识（用于防重复处理） */
  function getCurrentChatId() {
    try {
      const url = window.location.href;
      const match = url.match(/\/user\/(\d+)/);
      if (match) return match[1];
      const editor = editorBox();
      if (editor) {
        const container = editor.closest('[data-uid], [data-user-id], li[data-*]');
        if (container) {
          const uid = container.getAttribute('data-uid') || container.getAttribute('data-user-id');
          if (uid) return uid;
        }
      }
      return url;
    } catch (e) {
      return Date.now().toString();
    }
  }

  /** 检查输入框是否已包含相同内容 */
  function editorHasSameText(text) {
    const el = editorBox();
    if (!el) return false;
    const current = (el.innerText || el.textContent || '').trim();
    return current === text.trim();
  }

  /** 检查是否应该发送（防重复） */
  function shouldSend(text) {
    const now = Date.now();
    const textTrim = text.trim();
    if (!textTrim) return false;
    if (lastSentText === textTrim && now - lastSentTime < SAME_TEXT_COOLDOWN) {
      log('⚠️ 相同内容在 ' + Math.floor((SAME_TEXT_COOLDOWN - (now - lastSentTime)) / 1000) + ' 秒内已发送，跳过');
      return false;
    }
    if (editorHasSameText(textTrim)) {
      log('⚠️ 输入框已包含相同内容，跳过发送');
      return false;
    }
    return true;
  }

  /** 通过粘贴事件写入输入框（兼容 contenteditable），并触发 input */
  function fillInputViaPaste(text, inputEl) {
    const el = inputEl || editorBox();
    if (!el) {
      log("❌ 输入框未找到");
      return false;
    }
    el.focus();
    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer()
      });
      pasteEvent.clipboardData.setData("text/plain", text);
      el.dispatchEvent(pasteEvent);
    } catch (e) {}
    el.innerText = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  }

  function isChatSessionReady() {
    const box = editorBox();
    const btn = getRealSendButton();
    return !!(box && btn);
  }

  /** 查找图片上传按钮或文件输入框 */
  function findImageUploadButton() {
    // 方法1: 查找文件输入框
    const fileInputs = document.querySelectorAll('input[type="file"]');
    for (const input of fileInputs) {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      if (rect.width > 0 && rect.height > 0 && 
          style.visibility !== 'hidden' && 
          style.display !== 'none') {
        // 检查是否接受图片
        const accept = input.getAttribute('accept') || '';
        if (accept.includes('image') || accept === '' || !accept) {
          log('✅ 找到文件输入框（图片上传）');
          return input;
        }
      }
    }
    
    // 方法2: 查找图片图标按钮（通常包含图片相关的SVG或图标）
    const imageIcons = document.querySelectorAll('svg, button, div[role="button"]');
    for (const el of imageIcons) {
      const text = (el.innerText || el.textContent || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      
      // 检查是否包含图片相关的关键词
      if (text.includes('图片') || text.includes('image') || text.includes('photo') ||
          ariaLabel.includes('图片') || ariaLabel.includes('image') || ariaLabel.includes('photo') ||
          title.includes('图片') || title.includes('image') || title.includes('photo')) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width > 0 && rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none') {
          log('✅ 找到图片上传按钮（通过文本/标签）');
          return el;
        }
      }
      
      // 检查SVG路径是否包含图片相关的路径
      const svgPaths = el.querySelectorAll('path');
      for (const path of svgPaths) {
        const d = path.getAttribute('d') || '';
        // 图片图标通常有特定的路径特征
        if (d.length > 50) { // 图片图标路径通常较长
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20) {
            log('✅ 找到可能的图片上传按钮（通过SVG路径）');
            return el;
          }
        }
      }
    }
    
    // 方法3: 查找常见的图片上传选择器
    const commonSelectors = [
      'button[aria-label*="图片"]',
      'button[aria-label*="image"]',
      'div[role="button"][aria-label*="图片"]',
      '[data-testid*="image"]',
      '[data-testid*="upload"]',
      'input[accept*="image"]'
    ];
    for (const sel of commonSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && 
              style.visibility !== 'hidden' && 
              style.display !== 'none') {
            log('✅ 找到图片上传按钮（通过选择器）：' + sel);
            return el;
          }
        }
      } catch (e) {}
    }
    
    log('⚠️ 未找到图片上传按钮或文件输入框');
    return null;
  }

  /** 上传图片文件 */
  async function uploadImage(imagePath) {
    if (!imagePath || !imagePath.trim()) {
      log('⚠️ 图片路径为空，跳过上传');
      return false;
    }

    try {
      // 查找图片上传按钮或文件输入框
      const uploadButton = findImageUploadButton();
      if (!uploadButton) {
        log('❌ 未找到图片上传按钮');
        return false;
      }

      let fileToUpload = null;

      // 处理不同类型的图片路径
      if (imagePath.startsWith('data:')) {
        // Data URL（本地文件转换的）
        log('📤 检测到Data URL图片，准备上传');
        try {
          const response = await fetch(imagePath);
          const blob = await response.blob();
          fileToUpload = new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' });
        } catch (e) {
          log('❌ 转换Data URL失败：', e);
          return false;
        }
      } else if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        // HTTP/HTTPS URL
        log('🌐 检测到图片URL，正在下载：' + imagePath);
        try {
          const response = await fetch(imagePath);
          const blob = await response.blob();
          fileToUpload = new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' });
          log('✅ 图片URL下载成功');
        } catch (e) {
          log('❌ 下载图片URL失败：', e);
          return false;
        }
      } else {
        log('⚠️ 不支持的图片路径格式：' + imagePath);
        return false;
      }

      // 如果是文件输入框，直接使用
      if (uploadButton.tagName === 'INPUT' && uploadButton.type === 'file') {
        log('📤 找到文件输入框，准备上传图片');
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(fileToUpload);
        uploadButton.files = dataTransfer.files;
        
        // 触发change事件
        uploadButton.dispatchEvent(new Event('change', { bubbles: true }));
        uploadButton.dispatchEvent(new Event('input', { bubbles: true }));
        log('✅ 图片已设置到文件输入框');
        await sleep(rand(500, 1000));
        return true;
      } else {
        // 如果是按钮，先点击它打开文件选择对话框
        log('🖱️ 点击图片上传按钮，打开文件选择对话框');
        simulateRealClick(uploadButton);
        await sleep(rand(300, 600));
        
        // 查找新出现的文件输入框
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
          log('📤 找到文件输入框，准备上传图片');
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(fileToUpload);
          fileInput.files = dataTransfer.files;
          
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          log('✅ 图片已设置到文件输入框');
          await sleep(rand(500, 1000));
          return true;
        } else {
          log('⚠️ 点击按钮后未找到文件输入框');
          return false;
        }
      }
    } catch (e) {
      log('❌ 上传图片时出错：', e);
      return false;
    }
  }

  function createPanel() {
    if (document.getElementById('dy-human-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'dy-human-panel';
    panel.innerHTML = `
      <style>
        #dy-human-panel button:hover{opacity:.9}
        #dy-human-panel button:active{transform:scale(.98)}
        #dy-status{transition:background .2s,color .2s}
        #dy-panel-header{
          display:flex;
          align-items:center;
          justify-content:space-between;
          margin-bottom:12px;
          padding-bottom:10px;
          border-bottom:1px solid rgba(0,0,0,0.06);
        }
        #dy-panel-title{
          font-weight:700;
          font-size:15px;
          letter-spacing:-0.02em;
          user-select:none;
        }
        #dy-minimize-btn{
          width:24px;
          height:24px;
          border:none;
          background:rgba(0,0,0,0.05);
          cursor:pointer;
          padding:0;
          display:flex;
          align-items:center;
          justify-content:center;
          color:#666;
          font-size:18px;
          line-height:1;
          border-radius:4px;
          transition:all .2s;
          flex-shrink:0;
        }
        #dy-minimize-btn:hover{
          background:rgba(0,0,0,0.1);
          color:#333;
        }
        #dy-panel-inner{
          transition:opacity .3s ease,transform .3s ease,max-height .3s ease;
          overflow:hidden;
        }
        #dy-human-panel.minimized #dy-panel-inner{
          opacity:0;
          transform:scale(0.95);
          pointer-events:none;
          max-height:0;
          margin:0;
          padding:0;
        }
        #dy-human-panel.minimized{
          width:auto;
          min-width:140px;
          padding:10px 14px;
        }
        #dy-human-panel.minimized #dy-panel-header{
          margin-bottom:0;
          padding-bottom:0;
          border-bottom:none;
        }
      </style>
      <div id="dy-panel-header">
        <div id="dy-panel-title" style="
          font-weight: 700;
          font-size: 15px;
          letter-spacing: -0.02em;
        ">抖音自动回复</div>
        <button id="dy-minimize-btn" type="button" title="最小化/展开">−</button>
      </div>
      <div id="dy-panel-inner" style="
        font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 13px;
        color: #1a1a1a;
        line-height: 1.4;
      ">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="color:#666;font-size:12px">状态</span>
          <span id="dy-status" style="
            display:inline-block;
            padding:2px 10px;
            border-radius:999px;
            font-size:12px;
            font-weight:600;
          ">初始化</span>
        </div>
        <div style="margin-bottom:12px">
          <span style="color:#666;font-size:12px">上次发送</span>
          <span id="dy-last" style="display:block;margin-top:2px;font-size:12px;color:#888">-</span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button id="dy-toggle" type="button" style="
            flex:1;
            padding:8px 12px;
            border:1px solid #e0e0e0;
            border-radius:8px;
            background:#f8f8f8;
            font-size:12px;
            font-weight:600;
            cursor:pointer;
            color:#333;
          ">开/关</button>
          <button id="dy-manual" type="button" style="
            flex:1;
            padding:8px 12px;
            border:none;
            border-radius:8px;
            background:linear-gradient(135deg,#FE2C55 0%,#ff4d6a 100%);
            color:#fff;
            font-size:12px;
            font-weight:600;
            cursor:pointer;
          ">手动回复</button>
        </div>
        <button id="dy-enable-auto" type="button" style="
          width:100%;
          padding:8px 12px;
          border:none;
          border-radius:8px;
          background:linear-gradient(135deg,#4CAF50 0%,#45a049 100%);
          color:#fff;
          font-size:12px;
          font-weight:600;
          cursor:pointer;
          margin-bottom:12px;
        ">启用自动回复</button>
        <div style="margin-bottom:6px">
          <label style="color:#666;font-size:12px">话术（仅发送第一句）</label>
        </div>
        <textarea id="dy-preview" rows="3" placeholder="例如：你好，稍后回复～" style="
          width:100%;
          box-sizing:border-box;
          margin-bottom:8px;
          padding:8px 10px;
          border:1px solid #e5e5e5;
          border-radius:8px;
          font-size:12px;
          font-family:inherit;
          resize:vertical;
          min-height:52px;
        "></textarea>
        <div style="margin-bottom:6px">
          <label style="color:#666;font-size:12px">图片（可选，留空则只发文字）</label>
        </div>
        <div style="display:flex;gap:4px;margin-bottom:8px">
          <input type="text" id="dy-image" placeholder="图片URL，例如：http://example.com/image.jpg" style="
            flex:1;
            box-sizing:border-box;
            padding:8px 10px;
            border:1px solid #e5e5e5;
            border-radius:8px;
            font-size:12px;
            font-family:inherit;
          "></input>
          <input type="file" id="dy-image-file" accept="image/*" style="display:none">
          <button type="button" id="dy-select-image" style="
            padding:8px 12px;
            border:1px solid #e0e0e0;
            border-radius:8px;
            background:#f8f8f8;
            font-size:11px;
            color:#666;
            cursor:pointer;
            white-space:nowrap;
          ">选择文件</button>
        </div>
        <div id="dy-image-preview" style="
          margin-bottom:8px;
          max-height:100px;
          overflow:hidden;
          border-radius:6px;
          display:none;
        "></div>
        <button id="dy-save" type="button" style="
          width:100%;
          padding:6px 12px;
          border:1px solid #e0e0e0;
          border-radius:6px;
          background:#fff;
          font-size:11px;
          color:#666;
          cursor:pointer;
        ">保存话术</button>
      </div>`;
    Object.assign(panel.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      width: '280px',
      background: '#fff',
      border: '1px solid rgba(0,0,0,0.06)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.04)',
      padding: '14px',
      zIndex: 99999999,
      borderRadius: '12px'
    });
    document.body.appendChild(panel);

    const toggle = document.getElementById('dy-toggle');
    const manual = document.getElementById('dy-manual');
    const enableAutoBtn = document.getElementById('dy-enable-auto');
    const preview = document.getElementById('dy-preview');
    const imageInput = document.getElementById('dy-image');
    const imageFileInput = document.getElementById('dy-image-file');
    const selectImageBtn = document.getElementById('dy-select-image');
    const imagePreview = document.getElementById('dy-image-preview');
    const saveBtn = document.getElementById('dy-save');
    const minimizeBtn = document.getElementById('dy-minimize-btn');
    const panelHeader = document.getElementById('dy-panel-header');

    // 最小化/展开功能
    function toggleMinimize() {
      panelMinimized = !panelMinimized;
      if (panelMinimized) {
        panel.classList.add('minimized');
        minimizeBtn.textContent = '+';
        minimizeBtn.title = '展开';
      } else {
        panel.classList.remove('minimized');
        minimizeBtn.textContent = '−';
        minimizeBtn.title = '最小化';
      }
      // 保存最小化状态
      if (chrome.storage && chrome.storage.local && chrome.storage.local.set) {
        chrome.storage.local.set({ PANEL_MINIMIZED: panelMinimized });
      }
    }

    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    // 点击标题栏也可以切换最小化（可选）
    panelHeader.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    toggle.addEventListener('click', () => {
      enabled = !enabled;
      chrome.storage && chrome.storage.local && chrome.storage.local.set({ ENABLED: enabled });
      updatePanel();
    });

    manual.addEventListener('click', () => tryAutoReply());

    enableAutoBtn.addEventListener('click', async () => {
      log('🚀 用户点击启用自动回复，开始自动展开私信栏...');
      const success = await autoHoverPrivateMessageButton();
      if (success) {
        log('✅ 私信栏已展开，自动回复功能已启用');
        enabled = true;
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ ENABLED: true });
        updatePanel();
        // 等待私信栏完全展开后，开始检测小红点
        setTimeout(() => {
          if (enabled && !locked) {
            tryAutoReply();
          }
        }, 500);
      } else {
        log('⚠️ 无法自动展开私信栏，请手动点击私信按钮');
      }
    });

    // 文件选择按钮点击事件
    selectImageBtn.addEventListener('click', () => {
      imageFileInput.click();
    });

    // 文件选择变化事件
    imageFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        // 将文件转换为Data URL或Blob URL
        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target.result;
          REPLY_IMAGE = dataUrl;
          imageInput.value = file.name; // 显示文件名
          // 显示预览
          if (imagePreview) {
            imagePreview.innerHTML = `<img src="${dataUrl}" style="max-width:100%;max-height:100px;border-radius:6px;" alt="预览">`;
            imagePreview.style.display = 'block';
          }
          // 保存到storage
          if (chrome.storage && chrome.storage.local && chrome.storage.local.set) {
            chrome.storage.local.set({ REPLY_IMAGE: REPLY_IMAGE });
          }
          log('✅ 图片文件已选择：' + file.name);
        };
        reader.readAsDataURL(file);
      }
    });

    saveBtn.addEventListener('click', () => {
      const v = (preview.value || '').trim();
      const img = (imageInput.value || '').trim();
      REPLY_TEXT = v || REPLY_TEXT;
      // 如果输入框是URL，使用URL；如果是文件名，使用已保存的Data URL
      if (img && (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('data:'))) {
        REPLY_IMAGE = img;
      } else if (img && REPLY_IMAGE && REPLY_IMAGE.startsWith('data:')) {
        // 保持已选择的文件
      } else {
        REPLY_IMAGE = img || '';
      }
      if (chrome.storage && chrome.storage.local && chrome.storage.local.set) {
        chrome.storage.local.set({ REPLY_TEXT: REPLY_TEXT, REPLY_IMAGE: REPLY_IMAGE }, () => {
          log('话术和图片已保存');
          updatePanel();
        });
      }
      updatePanel();
    });

    if (chrome.storage && chrome.storage.local && chrome.storage.local.get) {
      chrome.storage.local.get({ REPLY_TEXT, REPLY_IMAGE: '', ENABLED: true, PANEL_MINIMIZED: false }, res => {
        preview.value = res.REPLY_TEXT || REPLY_TEXT;
        REPLY_TEXT = res.REPLY_TEXT || REPLY_TEXT;
        REPLY_IMAGE = res.REPLY_IMAGE || '';
        enabled = typeof res.ENABLED === 'boolean' ? res.ENABLED : enabled;
        panelMinimized = typeof res.PANEL_MINIMIZED === 'boolean' ? res.PANEL_MINIMIZED : false;
        
        // 恢复最小化状态
        if (panelMinimized) {
          panel.classList.add('minimized');
          minimizeBtn.textContent = '+';
          minimizeBtn.title = '展开';
        }
        
        // 设置图片输入框和预览
        if (REPLY_IMAGE) {
          if (REPLY_IMAGE.startsWith('data:')) {
            // Data URL，显示预览
            imageInput.value = '已选择本地文件';
            if (imagePreview) {
              imagePreview.innerHTML = `<img src="${REPLY_IMAGE}" style="max-width:100%;max-height:100px;border-radius:6px;" alt="预览">`;
              imagePreview.style.display = 'block';
            }
          } else {
            // URL，直接显示
            imageInput.value = REPLY_IMAGE;
            if (imagePreview) {
              imagePreview.style.display = 'none';
            }
          }
        } else {
          imageInput.value = '';
          if (imagePreview) {
            imagePreview.style.display = 'none';
          }
        }
        
        updatePanel();
      });
    } else {
      preview.value = REPLY_TEXT;
      imageInput.value = REPLY_IMAGE;
      updatePanel();
    }
  }

  function updatePanel() {
    const status = document.getElementById('dy-status');
    const last = document.getElementById('dy-last');
    const preview = document.getElementById('dy-preview');
    const imageInput = document.getElementById('dy-image');
    const imagePreview = document.getElementById('dy-image-preview');
    if (status) {
      status.textContent = enabled ? '已启用' : '已禁用';
      status.style.background = enabled ? 'rgba(0,180,90,0.12)' : 'rgba(0,0,0,0.06)';
      status.style.color = enabled ? '#009952' : '#666';
    }
    if (last) last.textContent = lastSend ? new Date(lastSend).toLocaleString() : '-';
    if (preview) preview.value = REPLY_TEXT;
    if (imageInput) {
      if (REPLY_IMAGE && REPLY_IMAGE.startsWith('data:')) {
        imageInput.value = '已选择本地文件';
      } else {
        imageInput.value = REPLY_IMAGE || '';
      }
    }
    if (imagePreview && REPLY_IMAGE && REPLY_IMAGE.startsWith('data:')) {
      imagePreview.innerHTML = `<img src="${REPLY_IMAGE}" style="max-width:100%;max-height:100px;border-radius:6px;" alt="预览">`;
      imagePreview.style.display = 'block';
    } else if (imagePreview) {
      imagePreview.style.display = 'none';
    }
  }

  function findChatItemFromDot(dotEl) {
    if (!dotEl) return null;
    try {
      const li = dotEl.closest && dotEl.closest('li');
      if (li) return li;
    } catch (e) {}
    try {
      const clickable = dotEl.closest && dotEl.closest('button,a,div[role="button"],div[role="link"],[onclick],[tabindex]');
      if (clickable) return clickable;
    } catch (e) {}
    let el = dotEl;
    for (let i = 0; i < 8 && el; i++) {
      if (el.matches && el.matches('div,li')) return el;
      el = el.parentElement;
    }
    return dotEl;
  }

  function findClickableAncestor(el) {
    if (!el) return null;
    try {
      const candidate = el.closest && el.closest('button,a,div[role="button"],div[role="link"],[onclick],[tabindex]');
      if (candidate) {
        const r = candidate.getBoundingClientRect();
        const s = getComputedStyle(candidate);
        if (r.width > 6 && r.height > 6 && s.pointerEvents !== 'none' && s.visibility !== 'hidden') return candidate;
      }
    } catch (e) {}
    let p = el;
    for (let i = 0; i < 8 && p; i++) {
      try {
        const r = p.getBoundingClientRect();
        const s = getComputedStyle(p);
        if (r.width > 6 && r.height > 6 && s.pointerEvents !== 'none' && s.visibility !== 'hidden') {
          const onclick = p.getAttribute && p.getAttribute('onclick');
          const role = p.getAttribute && p.getAttribute('role');
          const tabindex = p.getAttribute && p.getAttribute('tabindex');
          const cursor = s.cursor || '';
          if (onclick || role === 'button' || tabindex !== null || cursor.indexOf('pointer') !== -1) return p;
        }
      } catch (e) {}
      p = p.parentElement;
    }
    return null;
  }

  /** 查找私信按钮（用于自动悬停展开私信栏） */
  function findPrivateMessageButton() {
    const selectors = [
      'a[href*="/message"]',
      'a[href*="/im"]',
      'button:has-text("私信")',
      '[aria-label*="私信"]',
      '[title*="私信"]',
      'span:contains("私信")',
      'div:contains("私信")'
    ];
    
    // 方法1: 通过文本内容查找
    const allElements = [...document.querySelectorAll('a, button, div, span')];
    for (const el of allElements) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text === '私信' || text.includes('私信')) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width > 0 && rect.height > 0 && 
            style.visibility !== 'hidden' && 
            style.display !== 'none') {
          log('✅ 找到私信按钮（通过文本）：', text);
          return el;
        }
      }
    }
    
    // 方法2: 通过链接查找
    for (const sel of ['a[href*="/message"]', 'a[href*="/im"]', 'a[href*="/chat"]']) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && 
              style.visibility !== 'hidden' && 
              style.display !== 'none') {
            log('✅ 找到私信按钮（通过链接）：', sel);
            return el;
          }
        }
      } catch (e) {}
    }
    
    // 方法3: 通过aria-label或title查找
    for (const attr of ['aria-label', 'title']) {
      try {
        const el = document.querySelector(`[${attr}*="私信"]`);
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && 
              style.visibility !== 'hidden' && 
              style.display !== 'none') {
            log('✅ 找到私信按钮（通过' + attr + '）：', el.getAttribute(attr));
            return el;
          }
        }
      } catch (e) {}
    }
    
    log('⚠️ 未找到私信按钮');
    return null;
  }

  /** 自动悬停私信按钮1秒以展开私信栏 */
  async function autoHoverPrivateMessageButton() {
    const pmButton = findPrivateMessageButton();
    if (!pmButton) {
      log('⚠️ 未找到私信按钮，无法自动展开私信栏');
      return false;
    }
    
    try {
      log('🖱️ 开始自动悬停私信按钮...');
      
      // 滚动到可见区域
      pmButton.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      await sleep(200);
      
      // 触发鼠标进入事件（模拟悬停）
      pmButton.dispatchEvent(new MouseEvent('mouseenter', { 
        bubbles: true, 
        cancelable: true,
        view: window
      }));
      pmButton.dispatchEvent(new MouseEvent('mousemove', { 
        bubbles: true, 
        cancelable: true,
        view: window,
        clientX: pmButton.getBoundingClientRect().left + pmButton.getBoundingClientRect().width / 2,
        clientY: pmButton.getBoundingClientRect().top + pmButton.getBoundingClientRect().height / 2
      }));
      
      // 悬停1秒
      await sleep(1000);
      
      // 保持悬停状态，等待私信栏展开
      await sleep(500);
      
      log('✅ 已自动悬停私信按钮1秒，私信栏应已展开');
      return true;
    } catch (e) {
      log('❌ 自动悬停私信按钮时出错：', e);
      return false;
    }
  }

  /** 退出会话按钮：发送后点击返回上级，继续等待小红点 */
  function findExitButton() {
    const exitTexts = ['退出会话', '退出', '离开会话'];
    const bySelector = [
      '#island_b69f5 > div > ul:nth-child(5) > div > li > div > div > div.vgonMAXk._VnLWL_m > div > div > div.w5duGc5Q.n4DfbtPU > div > div.gk_vYpRE > span',
      '#island_b69f5 div.w5duGc5Q.n4DfbtPU div.gk_vYpRE span',
      '#island_b69f5 div.gk_vYpRE span'
    ];
    for (const sel of bySelector) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          const t = (el.innerText || '').trim();
          if (exitTexts.some(x => t === x)) return el;
        }
        if (nodes.length === 1) return nodes[0];
      } catch (e) {}
    }
    const candidates = [...document.querySelectorAll('button,div,span')];
    for (const c of candidates) {
      if (!c.innerText) continue;
      const t = c.innerText.trim();
      if (exitTexts.includes(t)) return c;
    }
    return null;
  }

  async function tryAutoReply() {
    if (!enabled) return;
    if (locked) {
      log('⏸️ 已有任务进行中，跳过');
      return;
    }
    if (Date.now() - lastSend < COOLDOWN) {
      const remain = Math.ceil((COOLDOWN - (Date.now() - lastSend)) / 1000);
      log('⏸️ 冷却中，还需 ' + remain + ' 秒');
      return;
    }

    const red = await findRedDotElementAsync();
    if (!red) return;

    // 先通过小红点找到对应的会话ID，检查是否在1秒冷却期内
    let detectedChatId = null;
    try {
      const listItem = (red && red.closest && (
        red.closest('li') || 
        red.closest('[data-uid]') || 
        red.closest('[role="listitem"]') ||
        red.closest('div[data-uid]')
      )) || findChatItemFromDot(red);
      if (listItem) {
        detectedChatId = getChatIdFromItem(listItem);
      }
    } catch (e) {}

    // 如果无法从列表项获取，尝试从当前页面URL获取（如果已在会话内）
    if (!detectedChatId) {
      detectedChatId = getCurrentChatId();
    }

    // 检查该会话是否在1秒回复冷却期内
    if (detectedChatId && isChatInReplyCooldown(detectedChatId)) {
      const replyTime = chatReplyTimes.get(String(detectedChatId));
      const remain = Math.ceil((CHAT_REPLY_COOLDOWN - (Date.now() - replyTime)) / 1000);
      log('⏸️ 会话 ' + detectedChatId + ' 在1秒回复冷却期内，还需 ' + remain + ' 秒');
      return;
    }

    const chatId = getCurrentChatId();
    if (currentChatId === chatId && Date.now() - lastSend < COOLDOWN) {
      log('⏸️ 当前会话刚处理过，跳过');
      return;
    }

    locked = true;
    currentChatId = detectedChatId || chatId;
    log('✅ 发现未读小红点，开始自动回复流程（会话ID: ' + currentChatId + '）');

      try {
        chrome.storage && chrome.storage.local && chrome.storage.local.get({ REPLY_TEXT, REPLY_IMAGE: '' }, res => {
          REPLY_TEXT = res.REPLY_TEXT || REPLY_TEXT;
          REPLY_IMAGE = res.REPLY_IMAGE || '';
        });

      try { red.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      red.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
      red.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      try {
        // 找到包含红色标识的聊天条目
        const li = red.closest && (red.closest('li') || red.closest('[data-uid]') || red.closest('[role="listitem"]'));
        if (li) {
          li.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
          li.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        }
      } catch (e) {}
      await sleep(rand(150, 350));

      // 找到包含红色标识的聊天条目（支持红色数字徽章）
      const listItem = (red && red.closest && (
        red.closest('li') || 
        red.closest('[data-uid]') || 
        red.closest('[role="listitem"]') ||
        red.closest('div[data-uid]')
      )) || findChatItemFromDot(red) || red;
      let expandedEl = null;
      try {
        if (listItem) {
          expandedEl = listItem.querySelector('div.J2483ny0.noSemiGlobal > span > span')
            || listItem.querySelector('span.PygT7Ced.e2e-send-msg-btn');
        }
      } catch (e) {}

      if (expandedEl) {
        const clickableExpanded = findClickableAncestor(expandedEl) || expandedEl.closest && expandedEl.closest('div,button,span');
        log('发现展开后的小红点，点击其可点击祖先：', clickableExpanded || expandedEl);
        if (clickableExpanded) {
          simulateRealClick(clickableExpanded);
          await sleep(rand(300, 900));
        } else {
          simulateRealClick(expandedEl);
          await sleep(rand(300, 900));
        }
      } else {
        const chat = findChatItemFromDot(red) || red;
        const clickable = findClickableAncestor(chat) || chat;
        log('未找到展开小红点，回退点击聊天项：', clickable);
        simulateRealClick(clickable);
        await sleep(rand(300, 900));
      }

      let editor = editorBox();
      if (!editor) {
        const fallbackSelector = '#island_b69f5 span.J2483ny0.noSemiGlobal';
        const fallback = document.querySelector(fallbackSelector);
        if (fallback) {
          log('未检测到 editor，尝试点击 fallback 选择器', fallbackSelector);
          simulateRealClick(fallback);
          await sleep(rand(200, 400));
          editor = editorBox();
        }
      }

      if (!editor) {
        let tried = false;
        for (let attempt = 0; attempt < 3 && !editor; attempt++) {
          try {
            const tryTarget = findClickableAncestor(red) || red;
            if (!tryTarget) break;
            tried = true;
            log('重试进入会话，第 ' + (attempt + 1) + ' 次，目标：', tryTarget);
            tryTarget.scrollIntoView({ block: 'center', inline: 'center' });
            tryTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            tryTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            simulateRealClick(tryTarget);
            await sleep(rand(300, 700) + attempt * 200);
            editor = editorBox();
          } catch (e) {}
        }
        if (!editor && tried) log('[DY-HUMAN] ⚠️ 多次尝试后仍未打开会话');
      }

      if (!editor) {
        console.warn('[DY-HUMAN] 未能进入会话，跳过本次回复');
        locked = false;
        currentChatId = null;
        return;
      }

      try { simulateRealClick(editor); await sleep(rand(100, 250)); } catch (e) {}

      const oneLine = getFirstSentence(REPLY_TEXT);
      const hasImage = REPLY_IMAGE && REPLY_IMAGE.trim();
      const hasText = oneLine && oneLine.trim();
      
      // 检查是否有内容可发送
      if (!hasImage && !hasText) {
        log('⚠️ 既没有文字也没有图片，跳过发送');
        locked = false;
        currentChatId = null;
        return;
      }

      // 检查是否应该发送（防重复）
      if (hasText && !shouldSend(oneLine)) {
        log('⏸️ 检测到重复发送，跳过本次');
        locked = false;
        currentChatId = null;
        return;
      }

      // 记录会话回复时间，防止重复回复
      recordChatReply(currentChatId);

      // ========== 第一步：发送图片（如果有） ==========
      if (hasImage) {
        // 检查图片是否在冷却期内（防重复发送）
        const now = Date.now();
        if (lastSentImage && now - lastSentImageTime < SAME_IMAGE_COOLDOWN) {
          const remain = Math.floor((SAME_IMAGE_COOLDOWN - (now - lastSentImageTime)) / 1000);
          log('⚠️ 图片在 ' + remain + ' 秒内已发送，跳过图片发送（确保只回复一次）');
        } else {
          log('📷 第一步：开始上传并发送图片：' + REPLY_IMAGE);
          chrome.storage && chrome.storage.local && chrome.storage.local.get({ REPLY_IMAGE }, res => {
            REPLY_IMAGE = res.REPLY_IMAGE || REPLY_IMAGE;
          });
          
          const imageUploaded = await uploadImage(REPLY_IMAGE.trim());
          if (imageUploaded) {
            log('✅ 图片上传成功，准备发送图片');
            await sleep(rand(500, 1000)); // 等待图片上传完成
            
            // 查找图片发送按钮
            let imageBtn = null;
            log('🔍 查找图片发送按钮...');
            
            // 等待图片发送按钮出现（最多等待3秒）
            for (let i = 0; i < 6; i++) {
              imageBtn = findImageSendButton();
              if (imageBtn) {
                const rect = imageBtn.getBoundingClientRect();
                const style = getComputedStyle(imageBtn);
                if (rect.width > 0 && rect.height > 0 && 
                    style.visibility !== 'hidden' && 
                    style.display !== 'none' &&
                    style.pointerEvents !== 'none') {
                  log('✅ 找到图片发送按钮，准备点击');
                  break;
                }
              }
              await sleep(500);
            }
            
            // 如果没找到图片发送按钮，尝试使用普通发送按钮
            if (!imageBtn) {
              log('⚠️ 未找到图片发送按钮，尝试使用普通发送按钮');
              imageBtn = document.querySelector('span.PygT7Ced.JnY63Rbk.e2e-send-msg-btn') || getRealSendButton();
            }
            
            if (imageBtn) {
              // 确保按钮可见
              try {
                imageBtn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await sleep(rand(200, 400));
              } catch (e) {}
              
              // 模拟人工点击
              try {
                const rect = imageBtn.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                
                imageBtn.dispatchEvent(new MouseEvent('mousemove', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: x,
                  clientY: y
                }));
                imageBtn.dispatchEvent(new MouseEvent('mouseenter', {
                  bubbles: true,
                  cancelable: true,
                  view: window
                }));
                await sleep(rand(100, 200));
              } catch (e) {}
              
              log('🖱️ 模拟人工点击图片发送按钮（确保只发送一次）');
              simulateRealClick(imageBtn);
              
              // 立即更新状态，防止重复发送图片
              lastSentImage = true;
              lastSentImageTime = Date.now();
              lastSentTime = Date.now();
              lastSend = Date.now();
              log('📤 图片已发送（确保只回复一次）');
              
              // 等待图片发送完成
              await sleep(rand(...SEND_DELAY));
              await sleep(rand(300, 600));
            } else {
              log('❌ 未找到图片发送按钮，图片发送失败');
            }
          } else {
            log('⚠️ 图片上传失败');
          }
        }
      }

      // ========== 第二步：发送文字（如果有，且与图片发送有间隔） ==========
      if (hasText) {
        // 如果之前发送了图片，等待间隔后再发送文字
        if (hasImage) {
          const interval = rand(...IMAGE_TEXT_INTERVAL);
          log('⏳ 图片已发送，等待 ' + Math.floor(interval / 1000) + ' 秒后再发送文字（确保发送间隔）');
          await sleep(interval);
        }
        
        log('📝 第二步：开始输入并发送文字：' + oneLine);
        
        // 重新获取编辑器（可能在发送图片后DOM有变化）
        let textEditor = editorBox();
        if (!textEditor) {
          log('⚠️ 发送图片后未找到输入框，尝试重新查找');
          await sleep(rand(300, 600));
          textEditor = editorBox();
        }
        
        if (textEditor) {
          // 清空输入框（确保没有残留内容）
          try {
            textEditor.focus();
            textEditor.innerText = '';
            textEditor.textContent = '';
            await sleep(rand(100, 200));
          } catch (e) {}
          
          // 输入文字
          fillInputViaPaste(oneLine, textEditor);
          await sleep(rand(150, 300));
          
          // 检查输入框内容
          const editorText = (textEditor.innerText || textEditor.textContent || '').trim();
          if (editorText !== oneLine.trim()) {
            log('⚠️ 输入框内容不匹配，重新写入');
            fillInputViaPaste(oneLine, textEditor);
            await sleep(rand(150, 300));
          }
          
          // 查找文字发送按钮
          let textBtn = document.querySelector('span.PygT7Ced.JnY63Rbk.e2e-send-msg-btn');
          if (!textBtn) textBtn = getRealSendButton();
          
          if (textBtn) {
            // 确保按钮可见
            try {
              textBtn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
              await sleep(rand(200, 400));
            } catch (e) {}
            
            // 模拟人工点击
            try {
              const rect = textBtn.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              
              textBtn.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y
              }));
              textBtn.dispatchEvent(new MouseEvent('mouseenter', {
                bubbles: true,
                cancelable: true,
                view: window
              }));
              await sleep(rand(100, 200));
            } catch (e) {}
            
            log('🖱️ 模拟人工点击文字发送按钮');
            simulateRealClick(textBtn);
            
            // 更新状态
            lastSentText = oneLine;
            lastSentTime = Date.now();
            lastSend = Date.now();
            log('📤 文字已发送');
            
            // 等待文字发送完成
            await sleep(rand(...SEND_DELAY));
            await sleep(rand(300, 600));
          } else {
            log('❌ 未找到文字发送按钮，文字发送失败');
            // 重试一次
            await sleep(rand(300, 600));
            textBtn = document.querySelector('span.PygT7Ced.JnY63Rbk.e2e-send-msg-btn') || getRealSendButton();
            if (textBtn) {
              simulateRealClick(textBtn);
              lastSentText = oneLine;
              lastSentTime = Date.now();
              lastSend = Date.now();
              log('📤 重试后文字发送成功');
              await sleep(rand(...SEND_DELAY));
            }
          }
        } else {
          log('❌ 未找到输入框，文字发送失败');
        }
      }
      
      // 最终状态更新
      if (hasImage && hasText) {
        log('✅ 图片和文字都已发送完成（存在间隔）');
      } else if (hasImage) {
        log('✅ 图片已发送完成');
      } else if (hasText) {
        log('✅ 文字已发送完成');
      }

      await sleep(rand(400, 800));

      // 退出当前会话，准备进入下一个会话
      const exitBtn = findExitButton();
      if (exitBtn) {
        log('🔄 点击退出会话，返回会话列表');
        simulateRealClick(exitBtn);
        const previousChatId = currentChatId;
        // 记录退出时间，10秒后可继续回复该会话
        if (previousChatId) {
          exitedChats.set(String(previousChatId), Date.now());
          log('📝 已记录会话 ' + previousChatId + ' 的退出时间，10秒后可继续回复');
        }
        currentChatId = null;
        await sleep(rand(1000, 1500));
        log('🔍 退出后等待页面稳定，准备查找下一个有未读消息的会话...');
        
        // 等待页面稳定后，查找下一个有小红点的会话
        await sleep(rand(1500, 2500));
        
        // 主动查找下一个有未读消息的会话（排除刚才处理的会话）
        const nextChatItem = await findNextUnreadChat(previousChatId);
        if (nextChatItem) {
          log('✅ 找到下一个有未读消息的会话，准备点击进入');
          
          // 找到可点击的元素（聊天条目本身或其内部的可点击元素）
          const clickableItem = findClickableAncestor(nextChatItem) || 
                               nextChatItem.querySelector('button, a, [role="button"], [role="link"]') ||
                               nextChatItem;
          
          // 滚动到可见区域
          try {
            clickableItem.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
            await sleep(rand(300, 500));
          } catch (e) {}
          
          // 触发鼠标事件
          clickableItem.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
          clickableItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
          await sleep(rand(200, 400));
          
          // 点击进入会话
          log('🖱️ 点击进入下一个会话...');
          simulateRealClick(clickableItem);
          
          // 等待进入会话
          await sleep(rand(1000, 2000));
          
          // 重置锁定状态，允许进入下一个会话
          locked = false;
          
          // 延迟一点后开始处理下一个会话，确保页面已完全稳定
          setTimeout(() => {
            if (enabled && !locked) {
              log('🚀 开始处理下一个会话...');
              tryAutoReply();
            }
          }, rand(1000, 2000));
        } else {
          log('ℹ️ 未找到其他有未读消息的会话，等待新消息');
          locked = false;
        }
      } else {
        currentChatId = null;
        log('⚠️ 未找到退出按钮，但已清除会话状态');
        locked = false;
      }

      log('✅ 自动回复完成');
      try { updatePanel(); } catch (e) {}

    } catch (e) {
      console.error('[DY-HUMAN] 自动回复流程出错', e);
      currentChatId = null;
    }

    locked = false;
  }

  /** 启动定时检测（每1秒检测一次小红点） */
  function startPeriodicCheck() {
    if (checkInterval) {
      clearInterval(checkInterval);
    }
    checkInterval = setInterval(() => {
      if (enabled && !locked) {
        tryAutoReply();
      }
    }, 1000);
    log("⏰ 已启动定时检测（每1秒检测一次小红点）");
  }

  /** 停止定时检测 */
  function stopPeriodicCheck() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      log("⏸️ 已停止定时检测");
    }
  }

  // 保留 MutationObserver 作为备用（但降低频率，避免与定时器冲突）
  const observer = new MutationObserver(() => {
    // 定时器已覆盖主要检测，这里只做轻量级触发
    // 不直接调用 tryAutoReply，避免频繁触发
  });

  observer.observe(document.body, { childList: true, subtree: true });
  
  // 启动定时检测
  startPeriodicCheck();
  
  // 页面卸载时清理定时器
  window.addEventListener('beforeunload', () => {
    stopPeriodicCheck();
  });
  
  log("🚀 已注入，定时检测已启动（每1秒检测一次小红点）");
  try { setTimeout(createPanel, 300); } catch (e) {
    window.addEventListener('load', () => setTimeout(createPanel, 600));
  }

  try {
    const wrap = (type) => {
      const orig = history[type];
      history[type] = function() {
        const res = orig.apply(this, arguments);
        window.dispatchEvent(new Event('dy-url-change'));
        return res;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('dy-url-change')));
    window.addEventListener('dy-url-change', () => {
      log('[DY-HUMAN] URL change detected — re-initializing UI');
      setTimeout(() => { 
        try { createPanel(); } catch(e) {}
        // 定时器会自动检测，这里不需要手动调用 tryAutoReply
      }, 450);
    });
  } catch (e) {}
})();
