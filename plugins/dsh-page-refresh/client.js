window.__ModuleLoader__.load({
  id: 'dsh-page-refresh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const inject = ['slots'];

    // 会话头右侧的刷新按钮：点了原地重载页面（等价 F5，不丢会话数据）
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

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-page-refresh', order: 999, label: '刷新页面' },
        () => React.createElement(RefreshButton),
      ));
    }

    exports.name = 'dsh-page-refresh-client';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
