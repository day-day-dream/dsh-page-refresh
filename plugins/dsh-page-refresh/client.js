window.__ModuleLoader__.load({
  id: 'dsh-page-refresh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const inject = ['slots'];
    const h = React.createElement;

    // ── 与刷新按钮同一套尺寸，并排时不跳 ────────────────────────────────
    const BTN = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      marginLeft: '4px',
      padding: 0,
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      fontSize: '15px',
      lineHeight: 1,
      cursor: 'pointer',
      opacity: 0.75,
      verticalAlign: 'middle',
    };
    const BTN_HOVER = { background: 'rgba(128,128,128,0.22)', opacity: 1 };
    const BTN_ACTIVE = { background: 'rgba(128,128,128,0.30)', opacity: 1 };

    // ── 下拉面板：半透明毛玻璃，与参考图同构（图标 + 文字，间距 10） ──────
    const MENU = {
      position: 'absolute',
      top: 'calc(100% + 7px)',
      right: 0,
      minWidth: '210px',
      padding: '6px',
      borderRadius: '11px',
      border: '1px solid rgba(255,255,255,0.17)',
      background: 'rgba(30,33,41,0.62)',
      backdropFilter: 'blur(22px) saturate(180%)',
      WebkitBackdropFilter: 'blur(22px) saturate(180%)',
      boxShadow: '0 16px 42px rgba(0,0,0,0.38)',
      zIndex: 2147483000,
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    };
    const ITEM = {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      width: '100%',
      padding: '8px 10px',
      border: 'none',
      borderRadius: '7px',
      background: 'transparent',
      color: '#E7E9EE',
      fontSize: '13px',
      lineHeight: 1.2,
      textAlign: 'left',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };
    const ITEM_HOVER = { background: 'rgba(255,255,255,0.10)' };
    const BACKDROP = {
      position: 'fixed',
      inset: 0,
      zIndex: 2147482999,
      background: 'transparent',
    };
    const NOTE = {
      padding: '7px 10px',
      fontSize: '12px',
      lineHeight: 1.55,
      color: '#C6CAD3',
      maxWidth: '210px',
      // §3.10-1：文案里有 '\n日志：…'，用 normal 会挤成一行 —— pre-wrap 保留换行又能自动折行。
      whiteSpace: 'pre-wrap',
    };
    const NOTE_BAD = { color: '#FF8A8A' };

    // ── 线性图标（24 网格，stroke 跟随 currentColor） ────────────────────
    function svgProps(size) {
      return {
        width: size || 16,
        height: size || 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      };
    }

    function IconPower(props) {
      return h('svg', svgProps(props.size),
        h('path', { key: 'a', d: 'M12 3.2v8.4' }),
        h('path', { key: 'b', d: 'M6.6 6.9a7.6 7.6 0 1 0 10.8 0' }),
      );
    }

    // 逆时针圆弧 + 左上箭头（对应参考图里的重启符号）
    function IconRestart(props) {
      return h('svg', svgProps(props.size),
        h('path', { key: 'a', d: 'M3.8 12a8.2 8.2 0 1 0 2.5-5.9' }),
        h('path', { key: 'b', d: 'M3.6 4.4v5.2h5.2' }),
      );
    }

    // §3.10-5：刷新图标改为与 IconPower / IconRestart 同规格的内联 SVG。
    // 原来用的是字符 '↻'，实测它的字体落到了 SimSun, serif —— 与另外两个按钮不同源，
    // 换字号就会偏。SVG 走 currentColor（svgProps 里已设 stroke），三者风格统一。
    function IconRefresh(props) {
      return h('svg', svgProps(props.size),
        h('path', { key: 'a', d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
        h('path', { key: 'b', d: 'M21 3v5h-5' }),
      );
    }

    // 全屏遮罩：点击的同一个 tick 里盖上，主人看到的就是「点下去界面没了」。
    // 不做渐隐 —— 渐隐反而把 0 延迟变回 120ms 的观感。
    function makeVeil(text) {
      const veil = document.createElement('div');
      veil.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#0b0b0f;' +
        'display:flex;align-items:center;justify-content:center;' +
        "color:#5a5a66;font:13px/1.6 system-ui,sans-serif;letter-spacing:1px";
      veil.textContent = text;
      document.body.appendChild(veil);
      return veil;
    }

    function PowerButton() {
      const [hover, setHover] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [hoverItem, setHoverItem] = React.useState('');
      const [note, setNote] = React.useState(null); // { bad, text }
      // §3.10-2：fire 进行中禁用两个条目。它与「条目常驻」是绑定关系 ——
      // 少了它，双击就会真起两个实例（提案 §5.2 已证伪过「客户端天然防重入」）。
      const [busy, setBusy] = React.useState(false);
      // §3.3 B：默认按 Windows 处理；挂载时探一次 /api/power/status，非 Windows 才置灰。
      const [winOnly, setWinOnly] = React.useState(true);
      const veilRef = React.useRef(null); // §3.10-3 遮罩句柄
      const menuRef = React.useRef(null); // §3.10-4 菜单句柄
      const btnRef = React.useRef(null); // §3.10-4 按钮句柄（Esc 后把焦点还回去）

      function close() {
        setOpen(false);
        setHoverItem('');
        setNote(null);
      }

      // §3.3 B 方案：非 Windows 直接置灰，不让主人点了才吃到 501。
      // 探不到（fetch 失败）就按可用处理 —— 点下去仍有 host 侧 501 兜底。
      React.useEffect(() => {
        let dead = false;
        fetch('/api/power/status', { cache: 'no-store' })
          .then((r) => r.json())
          .then((j) => { if (!dead && j && j.isWindows === false) setWinOnly(false); })
          .catch(() => {});
        return () => { dead = true; };
      }, []);

      // §3.10-3：组件卸载（切会话 / 热替换）时撤罩。
      // 原来 makeVeil 直接挂到 body 且没人撤，最长留 90 秒黑屏。
      React.useEffect(() => () => {
        if (veilRef.current && veilRef.current.parentNode) veilRef.current.remove();
        veilRef.current = null;
      }, []);

      // §3.10-4：打开时把焦点送进菜单第一项
      React.useEffect(() => {
        if (!open || !menuRef.current) return;
        const first = menuRef.current.querySelector('button[role="menuitem"]:not([disabled])');
        if (first) first.focus();
      }, [open]);

      // §3.10-4：Esc 关闭并把焦点还给按钮；↑/↓ 在条目间循环
      React.useEffect(() => {
        if (!open) return;
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
            if (btnRef.current) btnRef.current.focus();
            return;
          }
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          if (!menuRef.current) return;
          const items = Array.prototype.slice.call(
            menuRef.current.querySelectorAll('button[role="menuitem"]:not([disabled])'),
          );
          if (!items.length) return;
          e.preventDefault();
          const i = items.indexOf(document.activeElement);
          const next = e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
          items[next].focus();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      function removeVeil() {
        if (veilRef.current && veilRef.current.parentNode) veilRef.current.remove();
        veilRef.current = null;
      }

      async function fire(kind) {
        if (busy) return; // §3.10-2：与下面的 disabled 双保险，杜绝双击起两实例
        setBusy(true);
        try {
        // 关闭：界面上 0 毫秒盖黑，进程在后台死。
        // 渲染进程拿不到 Electron 的 app 对象（contextIsolation），调不了 app.quit()，
        // 但主人感知的是「界面在不在」—— 那就在点击的同一个 tick 里把界面抹掉，
        // 剩下的 200ms 谁也看不见。失败或 4 秒内没死就把界面还回来。
        //
        // 2026-10-29（issue #1 第 3 点）：不再 fetch(...).catch(() => {}) 一吞了之。
        // 非 2xx 直接显示状态码与响应体首行；网络错误显示原因。失败不再等到超时。
        if (kind === 'close') {
          setNote({ bad: false, text: '正在关闭 DeepSeek Harness' });
          veilRef.current = makeVeil('正在关闭 DeepSeek Harness');
          try {
            const r = await fetch('/api/power/close', { method: 'POST' });
            if (!r.ok) {
              const body = await r.text().catch(() => '');
              removeVeil();
              setNote({ bad: true, text: '关闭请求被拒 HTTP ' + r.status + (body ? '\n' + body.split('\n')[0].slice(0, 120) : '') });
              return;
            }
          } catch (e) {
            removeVeil();
            setNote({ bad: true, text: '关闭请求发不出去：' + (e && e.message ? e.message : '网络错误') });
            return;
          }
          setTimeout(() => {
            if (veilRef.current && veilRef.current.parentNode) {
              removeVeil();
              setNote({ bad: true, text: '4 秒内没关掉，可能被别的东西拦住了' });
            }
          }, 4000);
          return;
        }
        // 重启：同样立刻盖黑（写「正在重启」）。DSH 起来后页面会重载，
        // 遮罩跟着页面一起消失，不用主人盯着旧界面等那 30 秒。
        // 90 秒兜底：真没起来就把界面还回来，别让人对着黑屏发呆。
        setNote({ bad: false, text: '正在重启 DeepSeek Harness' });
        veilRef.current = makeVeil('正在重启 DeepSeek Harness');
        let logHint = '';
        try {
          const r = await fetch('/api/power/restart', { method: 'POST' });
          if (!r.ok) {
            const body = await r.text().catch(() => '');
            removeVeil();
            setNote({ bad: true, text: '重启请求被拒 HTTP ' + r.status + (body ? '\n' + body.split('\n')[0].slice(0, 120) : '') });
            return;
          }
          try {
            const j = await r.json();
            if (j && j.logFile) logHint = '\n日志：' + j.logFile;
          } catch { /* 响应不是 JSON 也无所谓 */ }
        } catch (e) {
          removeVeil();
          setNote({ bad: true, text: '重启请求发不出去：' + (e && e.message ? e.message : '网络错误') });
          return;
        }
        setTimeout(() => {
          if (veilRef.current && veilRef.current.parentNode) {
            removeVeil();
            setNote({ bad: true, text: '没重启起来，双击桌面图标或告诉我' + logHint });
          }
        }, 90000);
        } finally {
          // 成功路径会重载页面 / 进程退出，恢复与否无所谓；失败路径必须恢复，
          // 否则条目会永久禁用 —— 那正是 §3.10-2「出错后要能再试」要保证的。
          setBusy(false);
        }
      }

      function item(kind, label, Icon) {
        const hot = !busy && hoverItem === kind;
        return h('button', {
          key: kind,
          type: 'button',
          role: 'menuitem',
          // §3.10-2：busy 期间真禁用（HTML disabled），不是只改样式 ——
          // 只改样式的话键盘 Enter / 快速双击照样能再次触发。
          disabled: busy,
          style: busy
            ? Object.assign({}, ITEM, { opacity: 0.45, cursor: 'default' })
            : (hot ? Object.assign({}, ITEM, ITEM_HOVER) : ITEM),
          onMouseEnter: () => setHoverItem(kind),
          onMouseLeave: () => setHoverItem(''),
          onClick: () => fire(kind),
        }, h(Icon, { size: 16 }), h('span', { key: 't' }, label));
      }

      const shown = open ? (hover ? Object.assign({}, BTN, BTN_ACTIVE) : BTN) : (hover ? Object.assign({}, BTN, BTN_HOVER) : BTN);

      return h('div', { style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          ref: btnRef,
          // §3.3 B 方案：非 Windows 直接置灰并说明原因，不让主人点了才吃到 501。
          title: winOnly ? '电源' : '电源（仅 Windows 可用）',
          'aria-label': winOnly ? '电源' : '电源（仅 Windows 可用）',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          disabled: !winOnly,
          style: winOnly ? shown : Object.assign({}, shown, { opacity: 0.4, cursor: 'default' }),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => (open ? close() : (setNote(null), setOpen(true))),
        }, h(IconPower, { size: 16 })),
        open ? h(React.Fragment, null,
          h('div', { key: 'bd', style: BACKDROP, onClick: close }),
          h('div', { key: 'menu', role: 'menu', ref: menuRef, style: MENU },
            // §3.10-2：条目常驻，note 只作顶部一行。原来 note 一设就把两个条目整体替换掉，
            // 出错后必须「关菜单 → 重开」才能再试一次。
            note
              ? h('div', {
                  key: 'note',
                  role: 'status',
                  'aria-live': 'polite',
                  style: note.bad ? Object.assign({}, NOTE, NOTE_BAD) : NOTE,
                }, note.text)
              : null,
            item('close', '关闭 DeepSeek Harness', IconPower),
            item('restart', '重启 DeepSeek Harness', IconRestart),
          ),
        ) : null,
      );
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      // 电源按钮排在刷新按钮（order 999）左边
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-page-refresh-power', order: 998, label: '电源' },
        () => React.createElement(PowerButton),
      ));

      // 原有的刷新按钮（点了原地重载页面，等价 F5，不丢会话数据）
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-page-refresh', order: 999, label: '刷新页面' },
        () => React.createElement(RefreshButton),
      ));
    }

    function RefreshButton() {
      const [hover, setHover] = React.useState(false);
      return React.createElement('button', {
        type: 'button',
        title: '刷新页面',
        'aria-label': '刷新页面',
        style: hover ? Object.assign({}, BTN, BTN_HOVER) : BTN,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => window.location.reload(),
      }, h(IconRefresh, { size: 16 })); // §3.10-5：与 IconPower/IconRestart 同源的内联 SVG
    }

    exports.name = 'dsh-page-refresh-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
