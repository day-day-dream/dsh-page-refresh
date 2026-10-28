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
      whiteSpace: 'normal',
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

      function close() {
        setOpen(false);
        setHoverItem('');
        setNote(null);
      }

      async function fire(kind) {
        // 关闭：界面上 0 毫秒盖黑，进程在后台死。
        // 渲染进程拿不到 Electron 的 app 对象（contextIsolation），调不了 app.quit()，
        // 但主人感知的是「界面在不在」—— 那就在点击的同一个 tick 里把界面抹掉，
        // 剩下的 200ms 谁也看不见。失败或 4 秒内没死就把界面还回来。
        //
        // 2026-10-29（issue #1 第 3 点）：不再 fetch(...).catch(() => {}) 一吞了之。
        // 非 2xx 直接显示状态码与响应体首行；网络错误显示原因。失败不再等到超时。
        if (kind === 'close') {
          setNote({ bad: false, text: '正在关闭 DeepSeek Harness' });
          const veil = makeVeil('正在关闭 DeepSeek Harness');
          try {
            const r = await fetch('/api/power/close', { method: 'POST' });
            if (!r.ok) {
              const body = await r.text().catch(() => '');
              if (veil.parentNode) veil.remove();
              setNote({ bad: true, text: '关闭请求被拒 HTTP ' + r.status + (body ? '\n' + body.split('\n')[0].slice(0, 120) : '') });
              return;
            }
          } catch (e) {
            if (veil.parentNode) veil.remove();
            setNote({ bad: true, text: '关闭请求发不出去：' + (e && e.message ? e.message : '网络错误') });
            return;
          }
          setTimeout(() => {
            if (veil.parentNode) {
              veil.remove();
              setNote({ bad: true, text: '4 秒内没关掉，可能被别的东西拦住了' });
            }
          }, 4000);
          return;
        }
        // 重启：同样立刻盖黑（写「正在重启」）。DSH 起来后页面会重载，
        // 遮罩跟着页面一起消失，不用主人盯着旧界面等那 30 秒。
        // 90 秒兜底：真没起来就把界面还回来，别让人对着黑屏发呆。
        setNote({ bad: false, text: '正在重启 DeepSeek Harness' });
        const veil = makeVeil('正在重启 DeepSeek Harness');
        let logHint = '';
        try {
          const r = await fetch('/api/power/restart', { method: 'POST' });
          if (!r.ok) {
            const body = await r.text().catch(() => '');
            if (veil.parentNode) veil.remove();
            setNote({ bad: true, text: '重启请求被拒 HTTP ' + r.status + (body ? '\n' + body.split('\n')[0].slice(0, 120) : '') });
            return;
          }
          try {
            const j = await r.json();
            if (j && j.logFile) logHint = '\n日志：' + j.logFile;
          } catch { /* 响应不是 JSON 也无所谓 */ }
        } catch (e) {
          if (veil.parentNode) veil.remove();
          setNote({ bad: true, text: '重启请求发不出去：' + (e && e.message ? e.message : '网络错误') });
          return;
        }
        setTimeout(() => {
          if (veil.parentNode) {
            veil.remove();
            setNote({ bad: true, text: '没重启起来，双击桌面图标或告诉我' + logHint });
          }
        }, 90000);
      }

      function item(kind, label, Icon) {
        const hot = hoverItem === kind;
        return h('button', {
          key: kind,
          type: 'button',
          role: 'menuitem',
          style: hot ? Object.assign({}, ITEM, ITEM_HOVER) : ITEM,
          onMouseEnter: () => setHoverItem(kind),
          onMouseLeave: () => setHoverItem(''),
          onClick: () => fire(kind),
        }, h(Icon, { size: 16 }), h('span', { key: 't' }, label));
      }

      const shown = open ? (hover ? Object.assign({}, BTN, BTN_ACTIVE) : BTN) : (hover ? Object.assign({}, BTN, BTN_HOVER) : BTN);

      return h('div', { style: { position: 'relative', display: 'inline-flex' } },
        h('button', {
          type: 'button',
          title: '电源',
          'aria-label': '电源',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          style: shown,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => (open ? close() : (setNote(null), setOpen(true))),
        }, h(IconPower, { size: 16 })),
        open ? h(React.Fragment, null,
          h('div', { key: 'bd', style: BACKDROP, onClick: close }),
          h('div', { key: 'menu', role: 'menu', style: MENU },
            note
              ? h('div', { style: note.bad ? Object.assign({}, NOTE, NOTE_BAD) : NOTE }, note.text)
              : [
                  item('close', '关闭 DeepSeek Harness', IconPower),
                  item('restart', '重启 DeepSeek Harness', IconRestart),
                ],
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
      }, '\u21BB'); // ↻
    }

    exports.name = 'dsh-page-refresh-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
