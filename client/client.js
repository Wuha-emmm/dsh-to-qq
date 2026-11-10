/**
 * dsh-to-qq — browser half.
 *
 * Fills three host slots: the QQ conversation as a main-area panel, its sidebar
 * row, and the bridge settings section. No build step — the DSH client module
 * loader hands us React, and this file writes elements directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-to-qq',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // Shared stylesheet: the status pulse plus the conversation polish. It is
    // rewritten on module load so a hot-reloaded client picks up CSS changes
    // without needing a full page reload.
    const STYLE_TEXT = [
      '@keyframes dshToQqPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dsh-to-qq-row{background:transparent;transition:background 120ms ease,box-shadow 120ms ease}',
      '.dsh-to-qq-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 6%,transparent)}',
      '.dsh-to-qq-row[data-active="true"]{background:linear-gradient(90deg,color-mix(in srgb,#4d6bfe 20%,transparent),color-mix(in srgb,#4d6bfe 6%,transparent));box-shadow:inset 2px 0 0 #4d6bfe}',
      '.dsh-to-qq-search:focus{border-color:color-mix(in srgb,#4d6bfe 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,#4d6bfe 16%,transparent)}',
      '.dsh-to-qq-scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 20%,transparent) transparent}',
      '.dsh-to-qq-scroll::-webkit-scrollbar{width:8px}',
      '.dsh-to-qq-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 18%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.dsh-to-qq-scroll::-webkit-scrollbar-track{background:transparent}',
      '.dsh-to-qq-chip{transition:transform 120ms ease,box-shadow 120ms ease,border-color 120ms ease}',
      '.dsh-to-qq-chip:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(15,23,42,.10)}',
    ].join('\n');
    if (typeof document !== 'undefined') {
      let sheet = document.getElementById('dsh-to-qq-style');
      if (sheet === null) {
        sheet = document.createElement('style');
        sheet.id = 'dsh-to-qq-style';
        document.head.appendChild(sheet);
      }
      sheet.textContent = STYLE_TEXT;
    }


    /** Fetch JSON from the bridge with the page's own session. */
    const getJson = async path => {
      const response = await fetch(path, { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    };

    /** Post JSON to the bridge and read the JSON answer. */
    const postJson = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    };

    /** Post a File/Blob as the raw request body, keeping its image type. */
    const postBinary = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': body.type || 'application/octet-stream' },
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    };

    /** Read a dotted path from an object. */
    const getPath = (source, path) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), source);

    /** Return a copy of the object with one dotted path replaced. */
    const setPath = (source, path, value) => {
      const next = JSON.parse(JSON.stringify(source));
      const keys = path.split('.');
      let cursor = next;
      for (const key of keys.slice(0, -1)) cursor = cursor[key];
      cursor[keys[keys.length - 1]] = value;
      return next;
    };

    /** Editable settings, grouped the way the settings page presents them. */
    const SETTINGS_GROUPS = [
      {
        title: '连接',
        fields: [
          { path: 'connection.enabled', label: '启用桥接', type: 'checkbox' },
          { path: 'connection.httpUrl', label: 'OneBot HTTP', type: 'text', placeholder: 'http://127.0.0.1:3000/' },
          { path: 'connection.wsUrl', label: 'OneBot WS', type: 'text', placeholder: 'ws://127.0.0.1:3001' },
          { path: 'connection.eventPath', label: '事件路径', type: 'text', placeholder: '/' },
          { path: 'connection.snowlumaDir', label: 'SnowLuma 目录', type: 'text', placeholder: 'D:\\SnowLuma' },
          { path: 'accounts.browserPath', label: '登录浏览器路径', type: 'text', placeholder: '留空自动找 Edge / Chrome' },
          { path: 'accounts.debugPort', label: '登录浏览器调试端口', type: 'number' },
          { path: 'connection.botUin', label: '机器人 QQ 号（0 = 自动识别）', type: 'number' },
          { path: 'connection.tokenEnv', label: 'token 环境变量名', type: 'text', placeholder: 'QQ_BOT_TOKEN' },
          { path: 'connection.autoStart', label: '自动启动 SnowLuma', type: 'checkbox' },
        ],
      },
      {
        title: '权限',
        fields: [
          { path: 'access.admins', label: '管理员 QQ（逗号分隔）', type: 'list', kind: 'admin' },
          {
            path: 'access.groupMode',
            label: '群策略',
            type: 'select',
            options: [
              { value: 'whitelist', label: '只看白名单里的群' },
              { value: 'blacklist', label: '屏蔽黑名单里的群' },
              { value: 'all', label: '所有群' },
            ],
          },
          { path: 'access.groups', label: '群号（逗号分隔）', type: 'list', kind: 'number' },
          { path: 'access.mentionOnly', label: '群内仅 @ 回应', type: 'checkbox' },
          {
            path: 'access.strangerPolicy',
            label: '陌生人私聊',
            type: 'select',
            options: [
              { value: 'ignore', label: '静默忽略' },
              { value: 'notice', label: '回一句未授权' },
              { value: 'block', label: '彻底拉黑' },
            ],
          },
          { path: 'limits.memberDaily', label: '成员每日条数', type: 'number' },
          { path: 'limits.groupDaily', label: '每群每日条数', type: 'number' },
          { path: 'limits.userPerMinute', label: '每人每分钟条数', type: 'number' },
          { path: 'limits.concurrency', label: '全局并发', type: 'number' },
          { path: 'limits.maxInputChars', label: '单条输入上限（字）', type: 'number' },
          { path: 'limits.replyDelayMs', label: '回复延迟 (ms)', type: 'number' },
          { path: 'limits.jitterMs', label: '随机抖动 (ms)', type: 'number' },
        ],
      },
      {
        title: '对话',
        fields: [
          { path: 'conversation.cwd', label: '会话项目文件夹', type: 'text' },
          { path: 'conversation.autoRebuildKb', label: '会话重建阈值 (KB)', type: 'number' },
          { path: 'conversation.archiveOldSessions', label: '重建时隐藏旧会话', type: 'checkbox' },
          { path: 'conversation.groupHistory', label: '群聊上文条数', type: 'number' },
          { path: 'conversation.groupCharCap', label: '注入字符上限', type: 'number' },
          { path: 'digest.enabled', label: '每天自动发群日报', type: 'checkbox' },
          { path: 'digest.hour', label: '日报时间 · 时（0-23）', type: 'number' },
          { path: 'digest.minute', label: '日报时间 · 分（0-59）', type: 'number' },
          { path: 'output.imageThreshold', label: '转图阈值（字）', type: 'number' },
          { path: 'output.maxReplyChars', label: '回复长度上限（字）', type: 'number' },
          { path: 'output.replyCharsOwner', label: '私聊回复上限 (字)', type: 'number' },
          { path: 'output.replyCharsGroup', label: '群聊回复上限 (字)', type: 'number' },
          { path: 'output.groupAtReply', label: '群聊回复前 @ 提问的人', type: 'checkbox' },
          { path: 'output.sendTypingStatus', label: '私聊显示「正在输入」', type: 'checkbox' },
        ],
      },
      {
        title: '记忆',
        fields: [
          { path: 'memory.summaryLimit', label: '记忆摘要上限（字）', type: 'number' },
          { path: 'memory.personaLimit', label: '人设上限（字）', type: 'number' },
          { path: 'memory.autoNoteEvery', label: '每 N 轮自动记一条', type: 'number' },
          { path: 'memory.impressionsEnabled', label: '攒够一批就自动整理印象', type: 'checkbox' },
          { path: 'memory.impressionEvery', label: '多少条发言整理一次', type: 'number' },
          { path: 'memory.impressionMinChars', label: '触发前最少有效字数', type: 'number' },
          { path: 'memory.impressionBudget', label: '印象总字数上限', type: 'number' },
        ],
      },
    ];

    /** Settings tabs: the field groups plus the model and archive panels. */
    const SETTINGS_TABS = [
      ...SETTINGS_GROUPS.map(group => ({ id: group.title, title: group.title, group })),
      { id: '外观', title: '外观', custom: 'appearance' },
      { id: '表情', title: '表情', custom: 'stickers' },
      { id: '模型', title: '模型', custom: 'models' },
      { id: '登录', title: '登录', custom: 'accounts' },
      { id: '用量', title: '用量', custom: 'usage' },
      { id: '档案', title: '档案', custom: 'archive' },
      { id: '备份', title: '备份', custom: 'backup' },
    ];

    /** One settings row. */
    /** Shared visual vocabulary so every control matches the Host themes. */
    const UI = {
      card: {
        background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
        borderRadius: 12, padding: '6px 16px 10px',
      },
      sectionTitle: {
        fontSize: 12, fontWeight: 600, letterSpacing: '.02em',
        color: 'var(--dsw-alias-label-secondary, inherit)', opacity: 0.85,
        margin: '18px 0 8px',
      },
      muted: { fontSize: 11, color: "var(--dsw-alias-label-secondary, inherit)", opacity: 0.7, lineHeight: 1.5 },
      input: {
        width: '100%', padding: '7px 10px', borderRadius: 8, fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)', outline: 'none',
      },
      primary: {
        padding: '7px 16px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600,
        background: '#4d6bfe', color: '#fff', cursor: 'pointer',
      },
      ghost: {
        padding: '7px 14px', borderRadius: 9, fontSize: 12, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      },
    };

    /** Ready-made panel backgrounds; ids are stored as `preset:<id>`. */
    const BACKGROUND_PRESETS = [
      { id: 'mist', label: '晨雾', css: 'linear-gradient(135deg,#dbeafe 0%,#ede9fe 50%,#fce7f3 100%)' },
      { id: 'dusk', label: '暮色', css: 'linear-gradient(135deg,#0f172a 0%,#312e81 50%,#831843 100%)' },
      { id: 'sakura', label: '樱粉', css: 'linear-gradient(135deg,#fff1f2 0%,#fce7f3 50%,#ede9fe 100%)' },
      { id: 'ocean', label: '深海', css: 'linear-gradient(135deg,#042f2e 0%,#0f766e 50%,#1e3a8a 100%)' },
    ];
    const PRESET_BY_ID = new Map(BACKGROUND_PRESETS.map(preset => [preset.id, preset]));

    /** Turn a stored background value into CSS, or `{}` when it is empty. */
    const backgroundStyle = value => {
      const text = String(value ?? '');
      if (text.startsWith('preset:')) {
        const preset = PRESET_BY_ID.get(text.slice(7));
        return preset === undefined ? {} : { backgroundImage: preset.css };
      }
      if (/^\/dsh-to-qq\/api\/panel\/background\?v=\d{1,16}$/.test(text)) {
        return { backgroundImage: `url("${text}")` };
      }
      return {};
    };

    /** Themed dropdown: native <select> popups ignore the app theme. */
    const Select = props => {
      const { value, options, onChange, disabled } = props;
      const [open, setOpen] = React.useState(false);
      const box = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = event => {
          if (box.current !== null && !box.current.contains(event.target)) setOpen(false);
        };
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);
      const current = options.find(option => option.value === value) ?? options[0];
      return h('div', { ref: box, style: { position: 'relative', width: '100%', opacity: disabled ? 0.5 : 1 } },
        h('button', {
          type: 'button',
          disabled,
          onClick: () => setOpen(previous => !previous),
          style: {
            ...UI.input, display: 'flex', alignItems: 'center', gap: 6,
            textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
          },
        },
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          current?.label ?? ''),
        h('span', { style: { fontSize: 9, opacity: 0.55 } }, open ? '▲' : '▼')),
        open ? h('div', {
          style: {
            position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 60,
            background: 'var(--dsw-alias-bg-layer-1, #1c1c1e)',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))',
            borderRadius: 9, padding: 4, maxHeight: 240, overflowY: 'auto',
            boxShadow: '0 10px 28px rgba(0,0,0,.38)',
          },
        }, options.map(option => h('button', {
          key: option.value,
          type: 'button',
          onClick: () => {
            onChange(option.value);
            setOpen(false);
          },
          style: {
            display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px',
            borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12,
            background: option.value === value ? 'rgba(77,107,254,.20)' : 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        }, option.label))) : null);
    };

    /** One settings row: label and hint on the left, control on the right. */
    /** One-line explanations shown under a settings label. */
    const FIELD_HINTS = {
      'connection.enabled': '关闭后桥不再收发任何消息，连接配置保留',
      'connection.httpUrl': 'OneBot HTTP 地址，用于发消息、查状态',
      'connection.wsUrl': 'OneBot 事件推送地址',
      'connection.eventPath': '事件路径，SnowLuma 通常是 /',
      'connection.snowlumaDir': '填了才能自动启动 / 重启 SnowLuma',
      'connection.autoStart': '随 DSH 启动时拉起 SnowLuma',
      'access.admins': '管理员 QQ 号，逗号分隔；私聊全权',
      'access.groups': '允许进出的群号，逗号分隔',
      'access.groupMode': '群聊响应方式：关闭 / 仅 @ / 全部',
      'access.mentionOnly': '群里只有 @ 机器人才回应',
      'access.strangerPolicy': '陌生人私聊策略：忽略 / 仅问答',
      'conversation.cwd': 'QQ 会话归到这个文件夹（DSH 侧边栏按它分组）；留空用 DSH 默认',
      'conversation.autoRebuildKb': '会话超过这个大小才自动重建（默认 0 = 不自动重建，改用 /重建）；缓存命中价只有 1/50，重建反而会打断缓存',
      'conversation.groupHistory': '每次回答带上的群消息条数',
      'conversation.groupCharCap': '注入上下文的字数上限',
      'digest.enabled': '每天固定时间把群日报图发到群',
      'digest.hour': '北京时间，0–23',
      'digest.minute': '0–59',
      'limits.memberDaily': '每人每天最多提问次数（0 = 不限）',
      'limits.groupDaily': '每个群每天最多回答次数',
      'limits.userPerMinute': '每分钟每人最多提问次数',
      'limits.maxInputChars': '单条消息超过这个长度会被截断',
      'limits.concurrency': '同时进行的回答数',
      'limits.replyDelayMs': '回答前的基础延迟，避免秒回',
      'limits.jitterMs': '在基础延迟上随机抖动，像真人',
      'memory.summaryLimit': '单张记忆卡最多保留的字数',
      'memory.personaLimit': '人设文本长度上限',
      'memory.autoNoteEvery': '每 N 轮对话提醒模型记一条；0 = 关闭',
      'memory.impressionsEnabled': '后台自动整理印象，不发消息',
      'memory.impressionEvery': '攒够多少条发言整理一次',
      'memory.impressionMinChars': '触发前至少要有多少有效字数',
      'memory.impressionBudget': '印象列表的总字数上限',
      'output.imageThreshold': '回答超过这个字数就转成图片',
      'output.maxReplyChars': '让模型尽量写这么短；超长的回复自动转成图片（0 = 不提示）',
      'output.style': '图片风格：浅色 / 深色 / 气泡',
      'output.fontSize': '图片字号',
      'output.sendTypingStatus': '回答前显示“正在输入”',
      'voice.enabled': '收到语音时自动转成文字',
      'voice.language': '识别语言，如 zh / en',
      'voice.command': '本地识别命令，{input} {language} 占位；留空不用',
      'archive.retentionDays': '档案保留天数，0 = 永久',
      'archive.mediaRetentionDays': '图片/语音/文件保留天数，通常比档案短',
      'connection.botUin': '填了就只接受这个号的事件；0 = 从第一条事件学习后锁定',
      'connection.tokenEnv': '把 token 放进这个环境变量，config.json 里就不留明文（重启生效）',
      'archive.media': '把收到的图片/转发图存到本地',
    };

    /**
     * Number-list editor. The rows are stored as numbers, so a naive controlled
     * input would re-parse on every keystroke and eat the comma (and any
     * full-width characters) before a second value could be typed. Keep the raw
     * text while typing and only parse it when the field loses focus.
     */
    const ListInput = props => {
      const { value, kind, onChange } = props;
      const asText = Array.isArray(value)
        ? value.map(item => (typeof item === 'object' && item !== null ? item.qq : item)).join(', ')
        : '';
      const [draft, setDraft] = React.useState(asText);
      const focused = React.useRef(false);

      React.useEffect(() => {
        if (!focused.current) setDraft(asText);
      }, [asText]);

      const commit = raw => {
        const numbers = String(raw)
          .split(/[,，、;；\s]+/)
          .map(part => Number(part.trim()))
          .filter(part => Number.isInteger(part) && part > 0);
        onChange(kind === 'admin' ? numbers.map(qq => ({ qq, name: '', addedAt: Date.now() })) : numbers);
      };

      return h('input', {
        type: 'text',
        value: draft,
        placeholder: props.placeholder ?? '',
        onFocus: () => { focused.current = true; },
        onChange: event => setDraft(event.target.value),
        onBlur: () => { focused.current = false; commit(draft); },
        onKeyDown: event => { if (event.key === 'Enter') commit(draft); },
        style: { ...UI.input, width: '100%' },
      });
    };

    /** One settings row: label and hint on the left, control on the right. */
    const SettingsRow = props => {
      const { field, value, onChange, hint, first } = props;
      const common = {
        value: field.type === 'checkbox' ? undefined : (value ?? ''),
        placeholder: field.placeholder ?? '',
        onChange: event => {
          const raw = event.target.value;
          if (field.type === 'number') onChange(Number(raw));
          else onChange(raw);
        },
        style: field.type === 'checkbox'
          ? { width: 17, height: 17, accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)', cursor: 'pointer' }
          : { ...UI.input, width: field.type === 'number' ? 120 : '100%' },
      };
      const control = field.type === 'select'
        ? h(Select, { value: value ?? '', options: field.options, onChange })
        : field.type === 'list'
          ? h(ListInput, { value, kind: field.kind, onChange, placeholder: field.placeholder })
          : field.type === 'checkbox'
            ? h('input', { ...common, type: 'checkbox', checked: value === true })
            : h('input', { ...common, type: field.type === 'number' ? 'number' : 'text' });
      return h('label', {
        style: {
          display: 'flex', alignItems: 'center', gap: 14, padding: '11px 0',
          borderTop: first ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))',
        },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary, inherit)' } }, field.label),
          (hint ?? '') === '' ? null : h('div', { style: { ...UI.muted, marginTop: 1 } }, hint)),
        h('div', { style: { flex: field.type === 'checkbox' ? '0 0 auto' : '0 0 52%' } }, control));
    };

    /** Model routes editable in the settings page. */
    const MODEL_TIERS = [
      { id: 'owner', label: '管理员私聊（全权）' },
      { id: 'member', label: '访客与群成员' },
      { id: 'summarizer', label: '推理翻译' },
    ];

    /** Model route picker for one tier. */
    /** Model route picker for one tier. */
    const ModelTier = props => {
      const { title, route, catalog, onChange } = props;
      const groups = catalog?.groups ?? [];
      const group = groups.find(item => item.id === route?.provider);
      const models = group?.models ?? [];
      const model = models.find(item => item.id === route?.model);
      const efforts = model?.reasoning?.efforts ?? [];
      const providers = [{ value: '', label: '默认服务商' }, ...groups.map(item => ({ value: item.id, label: item.name }))];
      const modelOptions = [{ value: '', label: '默认模型' }, ...models.map(item => ({ value: item.id, label: item.name }))];
      const effortOptions = [{ value: '', label: '默认推理级别' }, ...efforts.map(item => ({ value: item.id, label: item.name }))];
      return h('div', { style: { marginBottom: 14 } },
        h('div', { style: { fontSize: 12.5, marginBottom: 6 } }, title),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 45%', minWidth: 120 } },
            h(Select, { value: route?.provider ?? '', options: providers, onChange: next => onChange({ provider: next, model: '', effort: '' }) })),
          h('div', { style: { flex: '1 1 35%', minWidth: 100 } },
            h(Select, { value: route?.model ?? '', options: modelOptions, disabled: models.length === 0, onChange: next => onChange({ ...route, model: next }) })),
          efforts.length === 0 ? null : h('div', { style: { flex: '1 1 25%', minWidth: 96 } },
            h(Select, { value: route?.effort ?? '', options: effortOptions, onChange: next => onChange({ ...route, effort: next }) }))));
    };

    /** Optional site accounts: a separate browser window for manual sign-in. */
    const AccountsBox = () => {
      const [state, setState] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [cookieInput, setCookieInput] = React.useState({ bilibili: '', xiaohongshu: '' });
      const [stale, setStale] = React.useState({ bilibili: false, xiaohongshu: false });
      const load = () => getJson('/dsh-to-qq/api/accounts')
        .then(setState)
        .catch(reason => setNotice(`读取失败：${reason?.message ?? reason}`));
      const refresh = async () => {
        await load();
        try {
          const result = await postJson('/dsh-to-qq/api/accounts', { action: 'verify', provider: 'bilibili' });
          const accounts = result?.accounts ?? {};
          setStale({
            bilibili: accounts.bilibili?.loggedIn === true && result.loggedIn !== true,
            xiaohongshu: false,
          });
          if (accounts.bilibili?.loggedIn === true && result.loggedIn !== true) {
            setNotice('B站登录态已失效，需要重新登录');
          }
        } catch {
          // A verification failure must not hide the stored state.
        }
      };
      React.useEffect(() => { void refresh(); }, []);
      const openBrowser = async provider => {
        setBusy(provider);
        setNotice('正在打开登录窗口…');
        try {
          const result = await postJson('/dsh-to-qq/api/accounts', { action: 'browser-open', provider });
          if (result.ok !== true) { setNotice(result.error ?? '打开失败'); return; }
          setNotice(`${result.hint}。窗口关了也没关系：点「读取登录状态」会自动再打开`);
        } catch (reason) {
          setNotice(`打开失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };
      const readLogin = async provider => {
        setBusy(provider);
        setNotice('正在读取登录状态…');
        try {
          const result = await postJson('/dsh-to-qq/api/accounts', { action: 'browser-read', provider });
          if (result.ok !== true) { setNotice(result.error ?? '读取失败'); return; }
          setNotice(`${provider === 'bilibili' ? 'B站' : '小红书'}已登录${result.nickname ? `：${result.nickname}` : ''}`);
          setStale(current => ({ ...current, [provider]: false }));
          await load();
        } catch (reason) {
          setNotice(`读取失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };
      const saveCookie = async provider => {
        const value = cookieInput[provider].trim();
        if (value === '') { setNotice('先粘贴 cookie'); return; }
        setBusy(provider);
        try {
          const result = await postJson('/dsh-to-qq/api/accounts', { action: 'save-cookie', provider, cookie: value });
          if (result.ok !== true) { setNotice(result.error ?? '保存失败'); return; }
          setNotice(`${provider === 'bilibili' ? 'B站' : '小红书'}已保存${result.nickname ? `：${result.nickname}` : ''}`);
          setCookieInput(current => ({ ...current, [provider]: '' }));
          setStale(current => ({ ...current, [provider]: false }));
          await load();
        } catch (reason) {
          setNotice(`保存失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };
      const logout = async provider => {
        setBusy(provider);
        try {
          await postJson('/dsh-to-qq/api/accounts', { action: 'logout', provider });
          setNotice('已退出登录');
          await load();
        } catch (reason) {
          setNotice(`退出失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };
      // Colour carries the state: yellow = not signed in, green = signed in.
      const statusOf = provider => {
        const entry = state?.accounts?.[provider];
        if (entry === undefined) {
          return { text: '读取中…', color: 'var(--dsw-alias-label-secondary, inherit)', dot: 'var(--dsw-alias-border-l1, rgba(127,127,127,.4))' };
        }
        if (entry.loggedIn !== true) {
          return { text: '未登录', color: 'var(--dsw-alias-state-warn-primary, #b45309)', dot: '#eab308' };
        }
        if (stale[provider] === true) {
          return { text: '登录已失效，请重新登录', color: 'var(--dsw-alias-state-warn-primary, #b45309)', dot: '#eab308' };
        }
        const who = entry.nickname === '' ? (entry.uid > 0 ? `UID ${entry.uid}` : '已保存 cookie') : entry.nickname;
        return {
          text: `已登录：${who}（${entry.method === 'browser' ? '登录窗口' : 'cookie'}）`,
          color: 'var(--dsw-alias-state-success-primary, #16a34a)',
          dot: '#22c55e',
        };
      };
      const statusView = provider => {
        const status = statusOf(provider);
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11.5, color: status.color } },
          h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: status.dot, flex: '0 0 auto' } }),
          h('span', null, status.text));
      };
      const cookieRow = (provider, placeholder) => h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
        h('input', {
          key: 'input',
          value: cookieInput[provider],
          placeholder,
          onChange: event => setCookieInput(current => ({ ...current, [provider]: event.target.value })),
          style: { ...UI.input, flex: '1 1 320px' },
        }),
        h('button', { key: 'save', type: 'button', onClick: () => void saveCookie(provider), disabled: busy !== '', style: UI.ghost }, '保存 cookie'));
      const providerCard = (provider, title, note) => h('div', { style: { marginBottom: 14 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { fontSize: 12.5, flex: 1 } }, title),
          h('button', { type: 'button', onClick: () => void refresh(), disabled: busy !== '', style: { ...UI.ghost, padding: '2px 8px', fontSize: 11 } }, '刷新状态')),
        statusView(provider),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { key: 'open', type: 'button', onClick: () => void openBrowser(provider), disabled: busy !== '', style: UI.primary }, '打开登录窗口'),
          h('button', { key: 'read', type: 'button', onClick: () => void readLogin(provider), disabled: busy !== '', style: UI.ghost }, '读取登录状态'),
          h('button', { key: 'out', type: 'button', onClick: () => void logout(provider), disabled: busy !== '', style: UI.ghost }, '退出登录')),
        cookieRow(provider, note),
        h('div', { style: { ...UI.muted, marginTop: 6 } },
          '也可以不打开窗口，直接把浏览器的 cookie 粘进来'));
      return h('div', { style: { ...UI.card, marginBottom: 12 } },
        h('div', { style: { ...UI.muted, padding: '8px 0 10px' } },
          state?.browser === '' || state?.browser === undefined
            ? '没找到 Edge/Chrome，请在「连接」页签填写「登录浏览器路径」'
            : `登录窗口使用 ${state.browser.split(/[\\/]/).pop()} 的独立配置（调试端口 ${state.debugPort}），和你平时用的浏览器完全分开`),
        providerCard('bilibili', 'B站', '粘贴 SESSDATA=…; bili_jct=…'),
        h('div', { style: { paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))' } },
          providerCard('xiaohongshu', '小红书', '粘贴 web_session=…')),
        h('div', { style: { ...UI.muted, marginTop: 10 } },
          '登录只影响 fetch_page：访问对应站点时会带上这份 cookie，其他站点不受影响；cookie 存在状态目录的 accounts.json，不会写进 config.json'),
        notice === '' ? null : h('div', { style: { ...UI.muted, marginTop: 8 } }, notice));
    };

    /** Per-turn token usage and estimated cost. */
    const UsageBox = () => {
      const [data, setData] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const load = () => getJson('/dsh-to-qq/api/usage')
        .then(setData)
        .catch(reason => setStatus(`读取失败：${reason?.message ?? reason}`));
      React.useEffect(() => { void load(); }, []);
      const money = value => (value === null || value === undefined ? '未配置价格' : `¥${value.toFixed(4)}`);
      const pct = value => `${Math.round((value ?? 0) * 100)}%`;
      const today = data?.today;
      return h('div', { style: { ...UI.card, marginBottom: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 12.5 } }, '今日用量'),
            h('div', { style: UI.muted },
              today === undefined
                ? '读取中…'
                : `${today.turns} 轮（谷时 ${today.offPeakTurns ?? 0}） · 输入 ${today.input} / 输出 ${today.output} / 缓存命中 ${today.cache}（${pct(today.cacheRate)}） · 检索 ${today.calls ?? 0} 次 · ${money(today.cost)}`),
            h('div', { style: UI.muted },
              today?.subagents === undefined || (today.subagents.totals?.sessions ?? 0) === 0
                ? ''
                : `子智能体 ${today.subagents.totals.sessions} 个 · 输入 ${today.subagents.totals.input} / 输出 ${today.subagents.totals.output} / 缓存 ${today.subagents.totals.cache} · ${money(today.subagents.totals.cost)}`)),
          h('button', { type: 'button', onClick: load, style: UI.ghost }, '刷新')),
        h('div', { style: { ...UI.muted, margin: '6px 0 10px' } },
          data?.prices !== undefined && data.prices.input === 0 && data.prices.output === 0 && data.prices.cache === 0
            ? '未配置单价，只显示 token。去「模型」页签填 ¥/百万 token。'
            : ''),
        data?.recent === undefined || data.recent.length === 0
          ? h('div', { style: UI.muted }, '还没有记录。下一轮对话后这里会出现数据。')
          : h('div', { style: { fontSize: 11.5, lineHeight: 1.9 } },
            h('div', { style: { ...UI.muted, display: 'grid', gridTemplateColumns: '1.4fr .8fr .7fr .7fr .6fr .5fr .6fr', gap: 8 } },
              h('span', { key: 'a' }, '场景'), h('span', { key: 'b' }, '时间'),
              h('span', { key: 'c' }, '输入'), h('span', { key: 'd' }, '输出'),
              h('span', { key: 'g' }, '检索'),
              h('span', { key: 'e' }, '缓存'), h('span', { key: 'f' }, '费用')),
            data.recent.slice(0, 15).map(row => h('div', {
              key: `${row.scene}-${row.startedAt}`,
              style: { display: 'grid', gridTemplateColumns: '1.4fr .8fr .7fr .7fr .6fr .5fr .6fr', gap: 8 },
            },
              h('span', { key: 'a' }, row.scene),
              h('span', { key: 'b' }, `${new Date(row.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}${row.offPeak ? ' 谷' : ''}`),
              h('span', { key: 'c' }, String(row.input)),
              h('span', { key: 'd' }, String(row.output)),
              h('span', { key: 'e' }, pct(row.cacheRate)),
              h('span', { key: 'g' }, String(row.calls ?? 0)),
              h('span', { key: 'f' }, money(row.cost))))),
        status === '' ? null : h('div', { style: { ...UI.muted, marginTop: 8 } }, status));
    };

    /** Cleanup of stale bridge sessions, with an explicit preview step. */
    const CleanupBox = () => {
      const [preview, setPreview] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const load = () => getJson('/dsh-to-qq/api/sessions')
        .then(setPreview)
        .catch(reason => setStatus(`读取失败：${reason?.message ?? reason}`));
      React.useEffect(() => { void load(); }, []);
      const run = async () => {
        setBusy(true);
        setStatus('清理中…');
        try {
          const result = await postJson('/dsh-to-qq/api/sessions', {});
          setStatus(`已清理 ${result.archived} 个会话${result.failed === 0 ? '' : `（${result.failed} 个失败）`}，保留绑定中的 ${result.bound} 个 + ${result.keepHours} 小时内活跃的`);
          await load();
        } catch (reason) {
          setStatus(`清理失败：${reason?.message ?? reason}`);
        } finally {
          setBusy(false);
        }
      };
      const count = preview?.candidates?.length ?? 0;
      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))', paddingTop: 12, marginTop: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 12.5 } }, 'QQ 会话清理'),
            h('div', { style: UI.muted },
              preview === null
                ? '读取中…'
                : `可清理 ${count} 个（未绑定的旧会话；保留 ${preview.keepHours} 小时内活跃的、绑定中的 ${preview.bound} 个）`)),
          h('button', { type: 'button', onClick: () => { setPreview(null); void load(); }, style: UI.ghost }, '刷新'),
          h('button', {
            type: 'button',
            onClick: run,
            disabled: busy || count === 0,
            style: { ...UI.primary, opacity: busy || count === 0 ? 0.5 : 1 },
          }, count === 0 ? '无可清理' : `清理 ${count} 个`)),
        Array.isArray(preview?.candidates) && preview.candidates.length > 0
          ? h('div', { style: { ...UI.muted, marginTop: 8, lineHeight: 1.7 } },
            preview.candidates.slice(0, 12).map(item => h('div', { key: item.id }, `· ${item.title ?? item.id}`)))
          : null,
        status === '' ? null : h('div', { style: { ...UI.muted, marginTop: 8 } }, status));
    };

    /** Archive size plus a manual cleanup button. */
    const ArchiveBox = () => {
      const [info, setInfo] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const load = () => getJson('/dsh-to-qq/api/archive')
        .then(setInfo)
        .catch(reason => setStatus(String(reason?.message ?? reason)));
      React.useEffect(() => {
        void load();
      }, []);
      const prune = async () => {
        setStatus('清理中…');
        try {
          const result = await postJson('/dsh-to-qq/api/prune', { days: info?.retentionDays ?? 30 });
          setStatus(`已清理 ${result.removed} 条消息、${result.files ?? 0} 个媒体文件（保留 ${result.days} 天）`);
          await load();
        } catch (reason) {
          setStatus(`清理失败：${reason?.message ?? reason}`);
        }
      };
      const stats = info?.stats;
      return h('div', {
        style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))', paddingTop: 12 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 12.5 } }, '档案存储'),
            h('div', { style: UI.muted },
              stats === null || stats === undefined
                ? '档案不可用（宿主缺少 node:sqlite）'
                : `共 ${stats.messages} 条消息，占用 ${(stats.bytes / 1048576).toFixed(2)} MB；保留 ${info.retentionDays} 天`)),
          h('button', { type: 'button', onClick: prune, style: UI.ghost }, '立即清理')),
        status === '' ? null : h('div', { style: { ...UI.muted, marginTop: 8 } }, status));
    };

    /**
     * Backup and restore.
     *
     * One zip carries the archive, memory cards, stickers and settings; the QQ
     * to DSH session bindings are deliberately left out, because a session id
     * only exists on the machine that created it. A restored binding that no
     * longer resolves is rebuilt on the first message, so nothing has to be
     * clicked after moving to a new computer.
     */
    const BackupPanel = props => {
      const [data, setData] = React.useState(null);
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [report, setReport] = React.useState(null);
      const [customPath, setCustomPath] = React.useState('');
      const [dryRun, setDryRun] = React.useState(true);
      const [clearBindings, setClearBindings] = React.useState(false);
      const [file, setFile] = React.useState(null);
      const fileRef = React.useRef(null);

      const load = () => getJson('/dsh-to-qq/api/backups')
        .then(setData)
        .catch(reason => setStatus(`读取备份列表失败：${reason?.message ?? reason}`));
      React.useEffect(() => {
        void load();
      }, []);

      const size = bytes => (bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(2)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`);

      const make = async () => {
        setBusy('backup');
        setStatus('正在打包…');
        try {
          const result = await postJson('/dsh-to-qq/api/backup', {});
          setStatus(`已生成 ${result.backup.name}（${size(result.backup.bytes)}），可下载后带到新机器`);
          await load();
        } catch (reason) {
          setStatus(`备份失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };

      const describe = result => {
        const counts = result?.counts ?? {};
        const parts = [
          `消息 ${counts.messages ?? 0}`,
          `记忆卡 ${counts.cards ?? 0}`,
          `表情 ${counts.stickers ?? 0}`,
        ];
        if (result?.backupBefore) parts.push(`恢复前快照 ${result.backupBefore}`);
        for (const warning of result?.warnings ?? []) parts.push(warning);
        return parts.join(' · ');
      };

      const restore = async (name, preview, path) => {
        if (preview !== true && !window.confirm(`恢复 ${name}？当前数据会先自动备份一份，完成后桥接会重连。`)) return;
        setBusy(preview === true ? 'preview' : 'restore');
        setStatus(preview === true ? '正在预演…' : '正在恢复…');
        try {
          const result = await postJson('/dsh-to-qq/api/restore', {
            ...(path === undefined ? { name } : { path }),
            dryRun: preview === true,
            clearBindings,
          });
          setReport(result);
          setStatus(preview === true
            ? '预演完成，没有写入任何数据'
            : `已恢复 ${result.restored?.length ?? 0} 个文件；桥接应已重连`);
          if (preview !== true) await load();
        } catch (reason) {
          setStatus(`恢复失败：${reason?.message ?? reason}（已回滚）`);
        } finally {
          setBusy('');
        }
      };

      const upload = async () => {
        if (file === null) {
          setStatus('先选一个 .zip 备份文件');
          return;
        }
        setBusy('upload');
        setStatus('上传中…');
        try {
          const name = `upload-${Date.now()}.zip`;
          const response = await fetch(`/dsh-to-qq/api/backup/upload?name=${encodeURIComponent(name)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/octet-stream' },
            body: file,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
          setStatus('上传完成，开始恢复…');
          await restore(name, false);
        } catch (reason) {
          setStatus(`上传失败：${reason?.message ?? reason}`);
        } finally {
          setBusy('');
        }
      };

      const remove = async name => {
        if (!window.confirm(`删除备份 ${name}？文件会被直接移除。`)) return;
        try {
          const response = await fetch(`/dsh-to-qq/api/backups?name=${encodeURIComponent(name)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
          setStatus(`已删除 ${name}`);
          await load();
        } catch (reason) {
          setStatus(`删除失败：${reason?.message ?? reason}`);
        }
      };

      const backups = data?.backups ?? [];
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))',
      };

      return [
        h('div', { key: 'make', style: UI.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0 4px' } },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, '立即备份'),
              h('div', { style: UI.muted },
                '把消息档案、记忆卡、表情库和设置打成一个 zip；会话绑定不迁移，换机后首次对话会自动重建')),
            h('button', {
              type: 'button',
              onClick: make,
              disabled: busy !== '',
              style: { ...UI.primary, opacity: busy === '' ? 1 : 0.6 },
            }, busy === 'backup' ? '打包中…' : '立即备份')),
          props.fieldRow({ path: 'backup.includeMedia', label: '包含表情预览与附件', type: 'checkbox' }),
          props.fieldRow({ path: 'backup.includeCookies', label: '包含登录 Cookie（新机器免重新登录）', type: 'checkbox' }),
          data?.directory === undefined
            ? null
            : h('div', { style: { ...UI.muted, paddingTop: 6 } },
              `备份目录：${data.directory}`,
              navigator.clipboard === undefined
                ? null
                : h('button', {
                  type: 'button',
                  onClick: () => void navigator.clipboard.writeText(data.directory).then(() => setStatus('路径已复制')),
                  style: { ...UI.ghost, marginLeft: 8, padding: '2px 8px' },
                }, '复制路径')),
          status === '' ? null : h('div', { style: { ...UI.muted, paddingTop: 8 } }, status)),

        h('div', { key: 'list', style: { ...UI.card, marginTop: 14 } },
          h('div', { style: UI.sectionTitle }, `备份记录${data === null ? '' : `（${backups.length}）`}`),
          data === null
            ? h('div', { style: { ...UI.muted, paddingBottom: 10 } }, '读取中…')
            : backups.length === 0
              ? h('div', { style: { ...UI.muted, paddingBottom: 10 } }, '还没有备份；点上面的「立即备份」生成第一份')
              : backups.map(row => h('div', { key: row.name, style: rowStyle },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.name),
                  h('div', { style: UI.muted },
                    `${size(row.bytes)} · ${new Date(row.mtime).toLocaleString('zh-CN')} · ${row.kind}`)),
                h('a', {
                  href: `/dsh-to-qq/api/backup/download?name=${encodeURIComponent(row.name)}`,
                  download: row.name,
                  style: { ...UI.ghost, textDecoration: 'none' },
                }, '下载'),
                h('button', {
                  type: 'button',
                  disabled: busy !== '',
                  style: UI.ghost,
                  onClick: () => void restore(row.name, true),
                }, '预演'),
                h('button', {
                  type: 'button',
                  disabled: busy !== '',
                  style: UI.ghost,
                  onClick: () => void restore(row.name, false),
                }, '恢复'),
                h('button', {
                  type: 'button',
                  disabled: busy !== '',
                  style: { ...UI.ghost, color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
                  onClick: () => void remove(row.name),
                }, '删除')))),

        h('div', { key: 'restore', style: { ...UI.card, marginTop: 14 } },
          h('div', { style: UI.sectionTitle }, '从文件恢复'),
          h('div', { style: { ...UI.muted, paddingBottom: 8 } },
            '换机流程：新机器装好插件 → 选这里的 zip → 恢复。消息、记忆、表情、管理员和群设置都会回来。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: '.zip,application/zip',
              onChange: event => setFile(event.target.files?.[0] ?? null),
              style: { fontSize: 12, maxWidth: 320 },
            }),
            h('button', {
              type: 'button',
              disabled: busy !== '',
              style: UI.ghost,
              onClick: () => void upload(),
            }, file === null ? '上传并恢复' : `上传并恢复（${(file.size / 1048576).toFixed(1)} MB）`)),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
            h('input', {
              value: customPath,
              placeholder: '或填 zip 的完整路径，例如 D:\\dsh-to-qq-backup.zip',
              onChange: event => setCustomPath(event.target.value),
              style: { ...UI.input, flex: 1 },
            }),
            h('button', {
              type: 'button',
              disabled: busy !== '' || customPath.trim() === '',
              style: UI.ghost,
              onClick: () => void restore(customPath.trim(), dryRun, customPath.trim()),
            }, dryRun ? '预演路径' : '按路径恢复')),
          h('label', { style: { ...UI.muted, display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 } },
            h('input', {
              type: 'checkbox',
              checked: dryRun,
              onChange: event => setDryRun(event.target.checked),
            }),
            '路径恢复时先预演，不写入（推荐）'),
          h('label', { style: { ...UI.muted, display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 } },
            h('input', {
              type: 'checkbox',
              checked: clearBindings,
              onChange: event => setClearBindings(event.target.checked),
            }),
            '清空会话绑定（一般不用勾：失效的会话会在下一轮自动重建）'),
          report === null
            ? null
            : h('div', { style: { ...UI.muted, marginTop: 10, lineHeight: 1.7 } },
              `${report.dryRun === true ? '预演结果' : '恢复结果'}：${report.name} · ${report.createdAt ?? ''} · 插件 ${report.version || '未知'} · ${describe(report)}`)),

        h('div', { key: 'auto', style: { ...UI.card, marginTop: 14 } },
          h('div', { style: UI.sectionTitle }, '自动备份'),
          props.fieldRow({ path: 'backup.auto', label: '每天自动备份一次', type: 'checkbox' }),
          props.fieldRow({ path: 'backup.keep', label: '自动备份保留份数', type: 'number' }),
          h('div', { style: { ...UI.muted, paddingTop: 6 } },
            '自动备份只包含数据文件，不含预览图；手动备份总是保留，不会被这份份数清掉。')),
      ];
    };
    /** Backfill button plus its live status: idle, running, or just finished. */
    const ImpressionBox = () => {
      const [state, setState] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const wasBusy = React.useRef(false);

      const load = () => getJson('/dsh-to-qq/api/impressions')
        .then(setState)
        .catch(reason => setNotice(`读取状态失败：${reason?.message ?? reason}`));

      React.useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), 3000);
        return () => window.clearInterval(timer);
      }, []);

      // When a run ends, replace any "started" message with the actual result.
      React.useEffect(() => {
        if (state === null) return undefined;
        const busyNow = state.busy === true;
        if (wasBusy.current && !busyNow) {
          const filled = Number(state.stats?.backfillFilled) || 0;
          const scanned = Number(state.stats?.scanned) || 0;
          setNotice(scanned === 0 ? '' : `补完：扫描 ${scanned} 人，成功 ${filled} 人`);
          const timer = window.setTimeout(() => setNotice(''), 10_000);
          return () => window.clearTimeout(timer);
        }
        wasBusy.current = busyNow;
        return undefined;
      }, [state]);

      const start = async () => {
        setNotice('');
        try {
          const result = await postJson('/dsh-to-qq/api/impressions', {});
          if (result?.started === false && result?.busy === true) setNotice('已经有一个补印象任务在跑');
          await load();
        } catch (reason) {
          setNotice(`启动失败：${reason?.message ?? reason}`);
        }
      };

      const busy = state?.busy === true;
      const stats = state?.stats ?? {};
      const total = Number(stats.total) || 0;
      const scanned = Number(stats.scanned) || 0;
      const percent = total === 0 ? 0 : Math.min(100, Math.round((scanned / total) * 100));
      const fmt = ts => (Number(ts) > 0 ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) : '—');
      const button = {
        padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: busy ? 'default' : 'pointer',
        border: 'none', background: '#4d6bfe', color: '#fff', fontWeight: 600, opacity: busy ? 0.6 : 1,
      };

      return h('div', { style: { marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', { type: 'button', onClick: start, disabled: busy, style: button },
            busy ? '正在补…' : '立即补印象'),
          h('div', { style: { fontSize: 12, opacity: 0.75 } },
            busy
              ? `正在补… ${scanned}/${total} 人（${percent}%）`
              : (Number(stats.lastAt) > 0
                ? `上次补：${fmt(stats.lastAt)} · 成功 ${Number(stats.backfillFilled) || 0} 人`
                : '还没补过')),
          h('div', { style: { marginLeft: 'auto', fontSize: 12, opacity: 0.6 } },
            state?.enabled === false ? '记忆整理已关闭' : '')),
        busy ? h('div', {
          style: { marginTop: 10, height: 6, borderRadius: 3, background: 'rgba(128,128,128,.25)', overflow: 'hidden' },
        }, h('div', {
          style: {
            width: `${percent}%`, height: '100%',
            background: '#4d6bfe', transition: 'width 300ms ease-out',
          },
        })) : null,
        notice === '' ? null : h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 8 } }, notice),
        (stats.lastError ?? '') === '' ? null : h('div', { style: { fontSize: 11, color: '#c0392b', marginTop: 6 } },
          `最近一次失败：${stats.lastError}`));
    };

    /** The settings page registered into the host's Settings surface. */
/** Pointer to the sticker tab, shown inside the conversation tab. */
const StickersHint = () => h('div', { style: { ...UI.muted, paddingTop: 10 } }, '表情包库在独立的「表情」页签里，可识别、预览和修改。');

/** Sticker library: thumbnail grid plus an editor for one sticker. */
const StickerBoard = () => {
  const [state, setState] = React.useState(null);
  const [selected, setSelected] = React.useState('');
  const [draft, setDraft] = React.useState({ code: '', category: '', desc: '' });
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = () => getJson('/dsh-to-qq/api/stickers')
    .then(data => {
      setState(data);
      const items = data.items ?? [];
      if (selected === '' && items.length > 0) setSelected(items[0].md5);
    })
    .catch(reason => setNotice(`读取失败：${reason?.message ?? reason}`));

  React.useEffect(() => {
    void load();
  }, []);

  const items = state?.items ?? [];
  const current = items.find(item => item.md5 === selected) ?? null;

  React.useEffect(() => {
    if (current === null) return;
    setDraft({ code: current.code ?? '', category: current.category ?? '', desc: current.desc ?? '' });
  }, [selected, state]);

  const sync = async () => {
    setBusy(true);
    setNotice('识别中…本次只处理没读过的');
    try {
      const result = await postJson('/dsh-to-qq/api/stickers', {});
      setNotice(`本次识别 ${result.described} 张，已存 ${result.previewed} 张预览；共 ${result.total} 张`);
      await load();
    } catch (reason) {
      setNotice(`识别失败：${reason?.message ?? reason}`);
    } finally {
      setBusy(false);
    }
  };

  /** Re-analyse every sticker the owner has not edited by hand. */
  /** Re-analyse only the sticker currently selected in the grid. */
  const reanalyze = async () => {
    if (current === null) {
      setNotice('先在网格里点一张表情，再点「重识别」');
      return;
    }
    const label = current.desc === '' ? current.code : `${current.code} ${current.desc.slice(0, 16)}`;
    if (window.confirm(`重新分析「${label}」？手改过的字段不会被覆盖。`) !== true) return;
    setBusy(true);
    setNotice('重新分析中…');
    try {
      const result = await postJson('/dsh-to-qq/api/stickers', { force: true, md5: current.md5 });
      if (result.described > 0) {
        setNotice('已更新这张表情的分析');
        await load();
        return;
      }
      setNotice('');
      await load();
    } catch (reason) {
      setNotice(`重分析失败：${reason?.message ?? reason}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (current === null) return;
    setBusy(true);
    try {
      await postJson('/dsh-to-qq/api/stickers/update', { md5: current.md5, ...draft });
      setNotice('已保存，下一轮对话生效');
      await load();
    } catch (reason) {
      setNotice(`保存失败：${reason?.message ?? reason}`);
    } finally {
      setBusy(false);
    }
  };

  const previewUrl = md5 => `/dsh-to-qq/api/stickers/preview?md5=${md5}`;
  const total = Number(state?.total) || 0;
  const read = Number(state?.read) || 0;

  const field = (label, key, placeholder) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
    h('span', { style: { flex: '0 0 48px', fontSize: 12, ...UI.muted } }, label),
    h('input', {
      value: draft[key],
      placeholder,
      onChange: event => setDraft(current2 => ({ ...current2, [key]: event.target.value })),
      style: { ...UI.input, flex: 1 },
    }));

  return h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, `收藏表情包 ${read}/${total}`),
        h('div', { style: UI.muted },
          total === 0 ? '还没同步过，点「识图」拉取收藏表情' : `已识别 ${read} 张，未识别 ${total - read} 张；点缩略图可改分类/备注/编号`)),
      h('button', {
        type: 'button',
        onClick: sync,
        disabled: busy,
        style: { ...UI.primary, opacity: busy ? 0.6 : 1 },
      }, busy ? '处理中…' : '识图'),
      h('button', {
        type: 'button',
        onClick: reanalyze,
        style: { ...UI.ghost, opacity: busy || current === null ? 0.5 : 1 },
      }, '重识别')),
    items.length === 0 ? null : h('div', {
      style: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(58px, 1fr))', gap: 8,
        maxHeight: 240, overflowY: 'auto', padding: 2,
      },
    }, items.map(item => h('button', {
      key: item.md5,
      type: 'button',
      onClick: () => setSelected(item.md5),
      title: item.desc === '' ? '未识别' : item.desc,
      style: {
        padding: 4, borderRadius: 8, cursor: 'pointer', background: 'transparent',
        border: item.md5 === selected
          ? '2px solid var(--dsw-alias-brand-primary, #4d6bfe)'
          : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
        opacity: item.read ? 1 : 0.55,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      },
    },
    item.file === ''
      ? h('div', { style: { width: '100%', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, ...UI.muted } }, '…')
      : h('img', { src: previewUrl(item.md5), alt: item.code, style: { width: '100%', height: 44, objectFit: 'contain' } }),
    h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, inherit)' } }, item.code)))),

    current === null ? null : h('div', {
      style: {
        display: 'flex', gap: 14, marginTop: 12, paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))',
      },
    },
    h('div', {
      style: {
        flex: '0 0 150px', height: 150, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
      },
    },
    current.file === ''
      ? h('span', { style: UI.muted }, '无预览')
      : h('img', { src: previewUrl(current.md5), alt: current.code, style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } })),
    h('div', { style: { flex: 1, minWidth: 0 } },
      field('编号', 'code', '用于 sticker_send，如 1e5442'),
      field('分类', 'category', '如 卖萌 / 无语 / 表情包梗'),
      field('备注', 'desc', '一句话描述，模型据此挑选'),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
        h('button', { type: 'button', onClick: save, disabled: busy, style: UI.primary }, '保存'),
        h('span', { style: UI.muted }, current.manual ? '已手动编辑' : current.read ? '模型识别' : '未识别')))),

    (notice !== '' || (state?.error ?? '') !== '')
      ? h('div', { style: { ...UI.muted, marginTop: 10, color: 'var(--dsw-alias-state-error-primary, #ef4444)' } },
        notice !== '' ? notice : `最近一次失败：${state.error}`)
      : null);
};


    /** Transport state to colour and label; green online, red offline. */
    const TRANSPORT_LOOK = {
      online: { text: '已连接', color: 'var(--dsw-alias-state-success-primary, #22c55e)' },
      connecting: { text: '连接中', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' },
      backoff: { text: '重连中', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' },
      'no-token': { text: '缺少 token', color: 'var(--dsw-alias-state-error-primary, #ef4444)' },
      disabled: { text: '已停用', color: 'var(--dsw-alias-state-idle-primary, #9ca3af)' },
      stopped: { text: '已停止', color: 'var(--dsw-alias-state-idle-primary, #9ca3af)' },
      idle: { text: '未连接', color: 'var(--dsw-alias-state-error-primary, #ef4444)' },
    };

    /** Coloured status dot with a soft halo. */
    const Dot = props => h('span', {
      style: {
        width: 8, height: 8, borderRadius: 999, background: props.color, flex: '0 0 auto',
        boxShadow: `0 0 0 3px ${props.color}26`,
        animation: props.pulse === true ? 'dshToQqPulse 1.6s ease-in-out infinite' : 'none',
      },
    });

    /** Background picker: presets, an uploaded picture, and readability controls. */
    const AppearancePanel = props => {
      const { config, setConfig, setStatus, fieldRow } = props;
      const [uploading, setUploading] = React.useState(false);
      const [uploadError, setUploadError] = React.useState('');
      const fileRef = React.useRef(null);
      const appearance = config.appearance ?? {};
      const background = String(appearance.background ?? '');
      const dim = Math.max(0, Math.min(95, Number(appearance.backgroundDim) || 0));
      const blur = Math.max(0, Math.min(24, Number(appearance.backgroundBlur) || 0));
      const previewStyle = backgroundStyle(background);
      const hasPreview = previewStyle.backgroundImage !== undefined;
      const selectedChip = id => background === `preset:${id}`;

      const update = (key, value) => {
        setConfig(current => {
          const base = current.appearance === undefined
            ? { ...current, appearance: { background: '', backgroundDim: 55, backgroundBlur: 0 } }
            : current;
          return setPath(base, `appearance.${key}`, value);
        });
        setStatus({ kind: 'dirty', text: '有未保存的修改' });
      };

      const upload = async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file === undefined) return;
        if (!String(file.type).startsWith('image/')) {
          setUploadError('请选择图片文件');
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          setUploadError('图片不能超过 8 MB');
          return;
        }
        setUploadError('');
        setUploading(true);
        try {
          const data = await postBinary('/dsh-to-qq/api/panel/background', file);
          if (typeof data.url !== 'string' || data.url === '') throw new Error('服务端没有返回图片地址');
          update('background', data.url);
        } catch (reason) {
          setUploadError(`上传失败：${String(reason?.message ?? reason)}`);
        } finally {
          setUploading(false);
        }
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 } },
        h('div', { style: UI.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0 8px' } },
            h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, '对话背景'),
            h('span', { style: { ...UI.muted, flex: 1 } }, '只影响本机面板，上传后保存才会生效')),
          h('div', {
            style: {
              position: 'relative', height: 190, borderRadius: 14, overflow: 'hidden',
              border: `1px solid ${PANEL_BORDER}`,
              background: 'linear-gradient(135deg,#eef2ff,#fae8ff 55%,#e0f2fe)',
            },
          },
          hasPreview ? h('div', {
            style: {
              position: 'absolute', inset: -8, ...previewStyle,
              backgroundSize: 'cover', backgroundPosition: 'center',
              filter: blur > 0 ? `blur(${blur}px)` : 'none',
              transform: blur > 0 ? 'scale(1.06)' : 'none',
            },
          }) : null,
          hasPreview ? h('div', {
            style: {
              position: 'absolute', inset: 0,
              background: `color-mix(in srgb, var(--dsw-alias-bg-base, #fff) ${dim}%, transparent)`,
            },
          }) : null,
          h('div', {
            style: {
              position: 'relative', zIndex: 1, height: '100%', boxSizing: 'border-box',
              padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
              color: 'var(--dsw-alias-label-primary, #1c1f24)',
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', {
              style: {
                width: 28, height: 28, borderRadius: 10, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
                background: 'linear-gradient(135deg,#4d6bfe,#7a5cf0)', color: '#fff',
              },
            }, 'Q'),
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, '聊天预览'),
            h('span', {
              style: {
                marginLeft: 'auto', fontSize: 10, opacity: 0.55, padding: '2px 7px', borderRadius: 20,
                background: 'color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 55%, transparent)',
              },
            }, '背景预览')),
          h('div', { style: { marginTop: 'auto', display: 'flex', gap: 8, alignItems: 'flex-end' } },
            h('span', {
              style: {
                width: 24, height: 24, borderRadius: 8, display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 10,
                background: 'color-mix(in srgb, var(--dsw-alias-label-primary,#111) 12%, transparent)',
              },
            }, '聊'),
            h('div', {
              style: {
                maxWidth: '72%', padding: '7px 10px', borderRadius: '12px 12px 12px 4px',
                fontSize: 11, lineHeight: 1.5,
                background: 'color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 82%, transparent)',
                border: `1px solid ${PANEL_BORDER}`,
              },
            }, '今晚换张背景图，看着舒服多了。')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('div', {
              style: {
                maxWidth: '72%', padding: '7px 10px', borderRadius: '12px 12px 4px 12px',
                fontSize: 11, lineHeight: 1.5,
                background: 'linear-gradient(135deg,#4d6bfe,#5c72ff)', color: '#fff',
              },
            }, '好，就这张。')))),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 } },
            h('button', {
              type: 'button',
              onClick: () => fileRef.current?.click(),
              disabled: uploading,
              style: { ...UI.primary, opacity: uploading ? 0.65 : 1 },
            }, uploading ? '上传中…' : '选择图片'),
            h('input', {
              ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
              onChange: upload, style: { display: 'none' },
            }),
            h('button', { type: 'button', onClick: () => update('background', ''), style: UI.ghost }, '恢复默认'),
            h('span', { style: UI.muted }, 'JPG / PNG / WebP / GIF · 8 MB 以内；上传后点右上角「保存」生效')),
          uploadError === '' ? null : h('div', {
            style: { fontSize: 11.5, color: 'var(--dsw-alias-state-error-primary, #c0392b)', paddingTop: 6 },
          }, uploadError),
          h('div', { style: { ...UI.muted, paddingTop: 8 } },
            background === '' ? '当前：主题纯色' : background.startsWith('preset:') ? '当前：预设背景' : '当前：自定义图片')),
        h('div', { style: { ...UI.sectionTitle, margin: '8px 0 0' } }, '预设背景'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8 } },
          BACKGROUND_PRESETS.map(preset => h('button', {
            key: preset.id,
            type: 'button',
            className: 'dsh-to-qq-chip',
            onClick: () => update('background', `preset:${preset.id}`),
            style: {
              padding: 6, borderRadius: 11, cursor: 'pointer', textAlign: 'left',
              border: selectedChip(preset.id) ? '2px solid #4d6bfe' : `1px solid ${PANEL_BORDER}`,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              color: 'inherit', fontSize: 11.5,
            },
          },
          h('span', {
            style: {
              display: 'block', height: 46, borderRadius: 7, backgroundImage: preset.css,
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)',
            },
          }),
          h('span', { style: { display: 'block', padding: '6px 2px 1px', fontWeight: selectedChip(preset.id) ? 600 : 500 } }, preset.label)))),
        h('div', { style: { ...UI.sectionTitle, margin: '12px 0 0' } }, '可读性'),
        h('div', { style: { ...UI.card, padding: '10px 16px 12px' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '5px 0' } },
            h('span', { style: { ...UI.muted, width: 78, fontSize: 12 } }, '背景遮罩'),
            h('input', {
              type: 'range', min: 0, max: 90, value: dim,
              onChange: event => update('backgroundDim', Number(event.target.value)),
              style: { flex: 1, accentColor: '#4d6bfe' },
            }),
            h('span', { style: { width: 42, textAlign: 'right', fontSize: 11, opacity: 0.6, fontVariantNumeric: 'tabular-nums' } }, `${dim}%`)),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '5px 0' } },
            h('span', { style: { ...UI.muted, width: 78, fontSize: 12 } }, '背景模糊'),
            h('input', {
              type: 'range', min: 0, max: 20, value: blur,
              onChange: event => update('backgroundBlur', Number(event.target.value)),
              style: { flex: 1, accentColor: '#4d6bfe' },
            }),
            h('span', { style: { width: 42, textAlign: 'right', fontSize: 11, opacity: 0.6, fontVariantNumeric: 'tabular-nums' } }, `${blur}px`)),
          h('div', { style: { ...UI.muted, paddingTop: 4 } }, '遮罩越高文字越清楚；模糊只作用于图片，不影响内容')),
        h('div', { style: { ...UI.sectionTitle, margin: '12px 0 0' } }, '回复图片'),
        h('div', { style: { ...UI.card, padding: '10px 16px 12px' } },
          fieldRow === undefined ? null : fieldRow({
            path: 'output.style',
            label: '图片样式',
            type: 'select',
            options: [
              { value: 'light', label: '白底黑字' },
              { value: 'dark', label: '暗色' },
              { value: 'bubble', label: '仿 QQ 气泡' },
            ],
          }),
          fieldRow === undefined ? null : fieldRow({ path: 'output.fontSize', label: '字号', type: 'number' }),
          h('div', { style: { ...UI.muted, paddingTop: 4 } }, '回复超过「对话」页的转图阈值就变成图片，这里决定图片长什么样')),
      );
    };

    /** Settings surface: header, tab strip, grouped cards, sticky save state. */
    const SettingsPage = () => {
      const [config, setConfig] = React.useState(null);
      const [catalog, setCatalog] = React.useState(null);
      const [status, setStatus] = React.useState({ kind: '', text: '' });
      const [saving, setSaving] = React.useState(false);
      const [tab, setTab] = React.useState('连接');
      /** Snapshot taken after load/save, so unsaved edits can be shown. */
      const [savedJson, setSavedJson] = React.useState('');
      /** Live transport state for the coloured connection pill. */
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        getJson('/dsh-to-qq/api/config')
          .then(data => {
            setConfig(data.config);
            setSavedJson(JSON.stringify(data.config));
          })
          .catch(reason => setStatus({ kind: 'error', text: `读取失败：${reason?.message ?? reason}` }));
        getJson('/dsh-to-qq/api/models')
          .then(data => setCatalog(data.catalog ?? null))
          .catch(() => setCatalog(null));
        const poll = () => getJson('/dsh-to-qq/api/state').then(setState).catch(() => setState(null));
        void poll();
        const timer = window.setInterval(poll, 5000);
        return () => window.clearInterval(timer);
      }, []);

      const save = async () => {
        setSaving(true);
        try {
          await postJson('/dsh-to-qq/api/config', { config });
          setSavedJson(JSON.stringify(config));
          setStatus({ kind: 'ok', text: '已保存，重启 DSH 后连接类改动才生效' });
          window.setTimeout(() => setStatus(current => (current.kind === 'ok' ? { kind: '', text: '' } : current)), 4000);
        } catch (reason) {
          setStatus({ kind: 'error', text: `保存失败：${reason?.message ?? reason}` });
        } finally {
          setSaving(false);
        }
      };

      if (config === null) {
        return h('div', { style: { padding: 28, fontSize: 13, ...UI.muted } },
          status.text === '' ? '读取配置…' : status.text);
      }

      const active = SETTINGS_TABS.find(item => item.id === tab) ?? SETTINGS_TABS[0];
      const lookState = state?.transport ?? 'idle';
      const look = { key: lookState, ...(TRANSPORT_LOOK[lookState] ?? TRANSPORT_LOOK.idle) };
      const dirty = savedJson !== '' && JSON.stringify(config) !== savedJson;

      let rowIndex = 0;
      const fieldRow = field => {
        rowIndex += 1;
        return h(SettingsRow, {
          key: field.path,
          field,
          value: getPath(config, field.path),
          hint: FIELD_HINTS[field.path],
          first: rowIndex === 1,
          onChange: next => {
            setConfig(current => setPath(current, field.path, next));
            setStatus({ kind: 'dirty', text: '有未保存的修改' });
          },
        });
      };

      const snowlumaUrl = typeof config.connection.snowlumaWebui === 'string' && config.connection.snowlumaWebui !== ''
        ? config.connection.snowlumaWebui
        : 'http://127.0.0.1:5099';

      /** Jump to the SnowLuma console, where the QQ hook is loaded by hand. */
      /** SnowLuma console + token state: a divider block, not a nested card. */
      const consoleCard = h('div', { key: 'snowluma', style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))', marginTop: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0 4px' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 } },
              h(Dot, { color: look.color }),
              h('span', null, 'SnowLuma 控制台'),
              h('span', { style: { ...UI.muted, color: look.color } }, look.text)),
            h('div', { style: { ...UI.muted, marginTop: 3 } }, '在那边加载 hook、扫码登录 QQ；登录成功后这里会自动连上。'),
            h('div', { style: { ...UI.muted, marginTop: 2 } }, snowlumaUrl)),
          h('button', {
            type: 'button',
            onClick: () => window.open(snowlumaUrl, '_blank', 'noopener,noreferrer'),
            style: {
              ...UI.ghost,
              background: `color-mix(in srgb, ${look.color} 16%, transparent)`,
              borderColor: `color-mix(in srgb, ${look.color} 45%, transparent)`,
              color: look.color,
              fontWeight: 600,
            },
          }, '打开控制台')),
        h('div', { style: { ...UI.muted, paddingTop: 8 } },
          config.connection.tokenSet
            ? 'OneBot token 已配置（出于安全不在界面显示）'
            : 'OneBot token 未配置：填 config.json，或设置环境变量名后重启'));

      const content = active.group !== undefined
        ? [
          h('div', { key: 'card', style: UI.card },
            active.group.fields.map(fieldRow),
            active.group.title === '记忆' ? h(ImpressionBox, { key: 'impressions' }) : null),
          active.group.title === '对话' ? h(StickersHint, { key: 'stickers-hint' }) : null,
          active.group.title === '连接' ? consoleCard : null,
        ].filter(Boolean)
        : active.custom === 'appearance'
          ? [h(AppearancePanel, { key: 'appearance', config, setConfig, setStatus, fieldRow })]
        : active.custom === 'stickers'
          ? [h(StickerBoard, { key: 'stickers' })]
        : active.custom === 'accounts'
          ? [h(AccountsBox, { key: 'accounts' })]
        : active.custom === 'usage'
          ? [h(UsageBox, { key: 'usage' })]
        : active.custom === 'backup'
          ? [h(BackupPanel, { key: 'backup', fieldRow })]
        : active.custom === 'models'
          ? [
            h('div', { key: 'card', style: UI.card },
              h('div', { style: { ...UI.muted, padding: '10px 0 6px' } },
                catalog === null ? '读取模型列表…' : '留空即用 DSH 的默认模型；改完对新会话立即生效，旧会话下轮生效'),
              MODEL_TIERS.map(tier => h(ModelTier, {
                key: tier.id,
                title: tier.label,
                route: config.models[tier.id],
                catalog,
                onChange: next => setConfig(current => setPath(current, `models.${tier.id}`, next)),
              }))),
              h('div', { key: 'prices', style: { marginTop: 10 } },
                h('div', { style: UI.sectionTitle }, '单价与计价'),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  fieldRow({ path: 'models.inputPrice', label: '输入 ¥/M', type: 'number' }),
                  fieldRow({ path: 'models.outputPrice', label: '输出 ¥/M', type: 'number' }),
                  fieldRow({ path: 'models.cachePrice', label: '缓存 ¥/M', type: 'number' })),
                fieldRow({ path: 'models.offPeakDiscount', label: '空闲折扣 (0-1)', type: 'number' }),
                fieldRow({ path: 'models.peakWindows', label: '高峰时段', type: 'text', placeholder: '09:00-12:00,14:00-18:00' }),
                fieldRow({ path: 'models.peakHolidays', label: '节假日(YYYY-MM-DD, 逗号)', type: 'text' }),
                fieldRow({ path: 'models.searchPrice', label: '联网检索每次 (元)', type: 'number' }),
                fieldRow({ path: 'models.fetchPrice', label: '网页抓取每次 (元)', type: 'number' })),
              h('div', { key: 'permission', style: { marginTop: 6 } },
                fieldRow({
                  path: 'models.permissionPreset',
                  label: 'QQ 会话权限',
                  type: 'select',
                  options: [
                    { value: '', label: '跟随 DSH 默认' },
                    { value: 'danger-full-access', label: '完全访问' },
                    { value: 'workspace-write', label: '只能写工作区' },
                    { value: 'auto', label: '自动' },
                  ],
                }),
                h('div', { style: { ...UI.muted, padding: '2px 0 8px' } },
                  '新建和恢复的 QQ 会话都会套用这个权限，和 DSH 窗口对齐；改完下一轮生效')),
          ]
          : [
            h('div', { key: 'card', style: UI.card },
              fieldRow({ path: 'archive.retentionDays', label: '保留天数', type: 'number' }),
              fieldRow({ path: 'archive.mediaRetentionDays', label: '媒体保留天数', type: 'number' }),
              fieldRow({ path: 'archive.media', label: '把收到的图片存到本地', type: 'checkbox' }),
              h(ArchiveBox, { key: 'archive' }),
              h(CleanupBox, { key: 'cleanup' })),
          ];

      const chip = (() => {
        if (dirty) return h('span', { style: { ...UI.muted, color: 'var(--dsw-alias-state-warn-primary, #b45309)' } }, '未保存');
        if (status.kind === 'ok') return h('span', { style: { ...UI.muted, color: 'var(--dsw-alias-state-success-primary, #16a34a)' } }, '已保存');
        if (status.kind === 'error') return h('span', { style: { ...UI.muted, color: 'var(--dsw-alias-state-error-primary, #c0392b)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, status.text);
        return null;
      })();

      return h('div', { style: { padding: '18px 20px 24px', fontSize: 13, maxWidth: 720 } },
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 14, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: 200 } },
            h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 650, letterSpacing: '-.01em' } }, 'QQ 桥接'),
            h('div', { style: { ...UI.muted, marginTop: 3 } }, '把本机的 DSH 接到 QQ：连接、权限、记忆、输出与档案'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, color: look.color } },
              h(Dot, { color: look.color, pulse: look.key === 'connecting' || look.key === 'backoff' }),
              h('span', { style: { fontWeight: 600 } }, look.text),
              h('span', { style: UI.muted }, config.connection.httpUrl))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            chip,
            h('button', {
              type: 'button',
              onClick: () => {
                setConfig(current => (savedJson === '' ? current : JSON.parse(savedJson)));
                setStatus({ kind: '', text: '' });
              },
              disabled: !dirty || saving,
              style: { ...UI.ghost, opacity: !dirty || saving ? 0.45 : 1 },
            }, '还原'),
            h('button', {
              type: 'button',
              onClick: save,
              disabled: saving,
              style: { ...UI.primary, opacity: saving ? 0.7 : 1 },
            }, saving ? '保存中…' : '保存'))),
        h('div', {
          role: 'tablist',
          style: {
            display: 'flex', gap: 16, flexWrap: 'nowrap', overflowX: 'auto', marginBottom: 16,
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
          },
        },
        SETTINGS_TABS.map(item => h('button', {
          key: item.id,
          type: 'button',
          role: 'tab',
          'aria-selected': item.id === active.id,
          onClick: () => setTab(item.id),
          style: {
            padding: '7px 1px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: -1,
            border: 'none',
            borderBottom: item.id === active.id ? '2px solid var(--dsw-alias-brand-primary, #4d6bfe)' : '2px solid transparent',
            background: 'transparent',
            color: item.id === active.id ? 'var(--dsw-alias-label-primary, inherit)' : 'var(--dsw-alias-label-secondary, inherit)',
            fontWeight: item.id === active.id ? 600 : 400,
          },
        }, item.title))),
        h('div', { role: 'tabpanel' }, content),
        h('div', { style: { ...UI.muted, marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))' } },
          `配置文件：${config.connection.configPath ?? '~/.dsh/dsh-to-qq/config.json'} · 连接类改动需重启 DSH`));
    };

    /** Turns a render crash into visible text instead of a blank settings page. */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { style: { padding: 24, fontSize: 13, color: '#c0392b' } },
            `设置页渲染出错：${String(this.state.error?.message ?? this.state.error)}`);
        }
        return this.props.children;
      }
    }

    /** Main-area panel key; the sidebar entry reuses it so clicking the row switches panels. */
    const PANEL_KEY = 'dsh-to-qq-chat';

    /** Sidebar glyph for the QQ row. */
    const QqPanelIcon = ({ size = 18 }) => h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M4 5.5h16v10.5H9.5L4 20z' }),
    h('path', { d: 'M8 10h8M8 13.5h5' }));

    /** Shared border colour so the two panes match the surrounding shell. */
    const PANEL_BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,.16))';

    /**
     * The QQ conversation as a main panel: conversations on the left, the chosen
     * thread on the right, reasoning folded behind one click and translated on
     * first open. Polls while visible so a reply arriving from DSH shows up
     * without a reload.
     *
     * @returns {any} Element tree.
     */
    /** Monospace stack for reasoning blocks: they read as logs, not prose. */
    const PANEL_MONO = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace';

    /** Group conversations and private chats get different accent colours. */
    const sceneAccent = scene => (String(scene).startsWith('group:') ? '#4d6bfe' : '#12a06a');

    /**
     * Rounded scene portrait with a name initial underneath the image.
     *
     * The image fades in on load; a missing portrait (offline transport, pruned
     * avatar) leaves the initial visible, so a row is never a broken-image icon.
     *
     * @param {{ scene: string, name?: string, size?: number }} props Scene, label, edge.
     * @returns {any} Element tree.
     */
    const SceneAvatar = props => {
      const accent = sceneAccent(props.scene);
      const size = Number(props.size) || 34;
      const initial = String(props.name ?? '').trim().slice(0, 1) || 'Q';
      return h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'relative',
          width: size,
          height: size,
          flex: `0 0 ${size}px`,
          borderRadius: Math.round(size * 0.32),
          overflow: 'hidden',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `${accent}22`,
          color: accent,
          fontSize: Math.max(11, Math.round(size * 0.4)),
          fontWeight: 600,
          lineHeight: 1,
          userSelect: 'none',
          boxShadow: props.ring === true
            ? `0 0 0 2px ${accent}55, 0 2px 6px rgba(0,0,0,.10)`
            : '0 1px 3px rgba(0,0,0,.08)',
        },
      },
      initial,
      h('img', {
        src: `/dsh-to-qq/api/avatar?scene=${encodeURIComponent(props.scene)}`,
        alt: '',
        loading: 'lazy',
        draggable: false,
        onLoad: event => { event.currentTarget.style.opacity = '1'; },
        onError: event => { event.currentTarget.style.opacity = '0'; },
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: 0,
          transition: 'opacity 140ms ease',
        },
      }));
    };

    /**
     * The QQ conversation as a main panel: conversations on the left, the chosen
     * thread on the right. Reasoning folds open per message and stays open while
     * you open another one; the list does not re-render when a poll returns the
     * same rows, and it only follows the newest message while you are parked at
     * the bottom, so opening a long block no longer throws the view around.
     *
     * @returns {any} Element tree.
     */
    const QqPanel = () => {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [active, setActive] = React.useState(null);
      const [messages, setMessages] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [open, setOpen] = React.useState({});
      const [translations, setTranslations] = React.useState({});
      const [query, setQuery] = React.useState('');
      const [pending, setPending] = React.useState(0);
      const scrollRef = React.useRef(null);
      const stickRef = React.useRef(true);
      const jumpRef = React.useRef(false);
      // Where the reader actually was, so a poll never yanks them to the top.
      const savedTopRef = React.useRef(0);
      const lastKeyRef = React.useRef('');
      const lastCountRef = React.useRef(0);

      React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
          try {
            const data = await getJson('/dsh-to-qq/api/state');
            if (cancelled) return;
            setState(data);
            setError('');
          } catch (reason) {
            if (!cancelled) setError(String(reason?.message ?? reason));
          }
        };
        void load();
        const timer = window.setInterval(() => void load(), 5000);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, []);

      const scenes = React.useMemo(() => {
        const rows = [...(state?.scenes ?? [])];
        rows.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));
        return rows;
      }, [state]);

      const byScene = React.useMemo(() => new Map(scenes.map(row => [row.scene, row])), [scenes]);

      // Newest conversation first: the panel opens on the last thing that happened.
      React.useEffect(() => {
        if (active === null && scenes.length > 0) setActive(scenes[0].scene);
      }, [scenes, active]);

      // Switching conversations starts from a clean slate: no stale open blocks.
      // The old thread is dropped immediately as well, so the new header never
      // sits on top of the previous conversation's messages while the fetch runs.
      React.useEffect(() => {
        setOpen({});
        setTranslations({});
        setPending(0);
        setMessages([]);
        setLoading(active !== null);
        stickRef.current = true;
        jumpRef.current = true;
        savedTopRef.current = 0;
        lastKeyRef.current = '';
        lastCountRef.current = 0;
      }, [active]);

      React.useEffect(() => {
        if (active === null) {
          setMessages([]);
          setLoading(false);
          return undefined;
        }
        let cancelled = false;
        const load = async () => {
          try {
            const data = await getJson(`/dsh-to-qq/api/messages?scene=${encodeURIComponent(active)}&limit=80`);
            if (cancelled) return;
            const next = data.messages ?? [];
            const newest = next.length === 0 ? undefined : next[next.length - 1];
            const nextKey = newest === undefined ? '' : `${newest.msg_id}@${newest.time_bj}`;
            const previousKey = lastKeyRef.current;
            if (previousKey !== '' && nextKey !== '' && nextKey !== previousKey && !stickRef.current) {
              const added = Math.max(1, next.length - lastCountRef.current);
              setPending(count => count + added);
            }
            lastKeyRef.current = nextKey;
            lastCountRef.current = next.length;
            // Same rows: keep the old array so React skips the whole re-render.
            setMessages(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
            setLoading(false);
          } catch (reason) {
            if (!cancelled) {
              setLoading(false);
              setError(String(reason?.message ?? reason));
            }
          }
        };
        void load();
        const timer = window.setInterval(() => void load(), 4000);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [active]);

      // Land at the bottom when the thread opens; while the reader stays at the
      // bottom every new message keeps the newest line in view.
      React.useEffect(() => {
        const element = scrollRef.current;
        if (element === null || messages.length === 0) return;
        const land = () => {
          if (!stickRef.current) return;
          element.scrollTop = element.scrollHeight;
          savedTopRef.current = element.scrollTop;
        };
        if (jumpRef.current) {
          stickRef.current = true;
          jumpRef.current = false;
          land();
          return;
        }
        if (stickRef.current) {
          land();
          // Images and media load after this frame and make the thread taller.
          window.requestAnimationFrame(land);
          setPending(count => (count === 0 ? count : 0));
          return;
        }
        // Reading history: put the scrollbar back exactly where it was.
        element.scrollTop = savedTopRef.current;
      }, [messages]);

      const onScroll = () => {
        const element = scrollRef.current;
        if (element === null) return;
        savedTopRef.current = element.scrollTop;
        const max = element.scrollHeight - element.clientHeight;
        // No overflow (or the panel has no height yet) means the reader is
        // already at the bottom; treating that as "scrolled up" is what used
        // to send the next new message back to the very top.
        const near = max <= 1 || max - element.scrollTop < 64;
        stickRef.current = near;
        if (near) setPending(count => (count === 0 ? count : 0));
      };

      const jumpToLatest = () => {
        const element = scrollRef.current;
        if (element === null) return;
        stickRef.current = true;
        setPending(0);
        element.scrollTop = element.scrollHeight;
        savedTopRef.current = element.scrollTop;
      };

      const toggleReasoning = index => {
        setOpen(current => ({ ...current, [index]: current[index] !== true }));
        const entry = messages[index];
        if (entry === undefined || typeof entry.reasoning !== 'string' || entry.reasoning === '') return;
        if (translations[index] !== undefined) return;
        setTranslations(current => ({ ...current, [index]: { status: 'loading' } }));
        postJson('/dsh-to-qq/api/translate', { text: entry.reasoning })
          .then(data => setTranslations(current => ({
            ...current,
            [index]: data.translated === false
              ? { status: 'unavailable', text: String(data.text ?? ''), note: String(data.error ?? '') }
              : { status: 'ok', text: String(data.text ?? '') },
          })))
          .catch(reason => setTranslations(current => ({ ...current, [index]: { status: 'error', text: String(reason?.message ?? reason) } })));
      };

      const kindOf = scene => (String(scene).startsWith('group:') ? 'group' : 'dm');
      const nameFor = scene => {
        const row = byScene.get(scene);
        const name = String(row?.name ?? '').trim();
        if (name !== '') return name;
        return kindOf(scene) === 'group' ? '群聊' : '私聊';
      };

      const needle = query.trim().toLowerCase();
      const shown = needle === ''
        ? scenes
        : scenes.filter(row => `${row.name ?? ''} ${row.scene}`.toLowerCase().includes(needle));
      const online = state?.transport === 'online';
      const appearance = state?.appearance ?? {};
      const background = String(appearance.background ?? '');
      const backgroundCss = backgroundStyle(background);
      const hasBackground = backgroundCss.backgroundImage !== undefined;
      const dim = Math.max(0, Math.min(95, Number(appearance.backgroundDim) || 0));
      const blur = Math.max(0, Math.min(24, Number(appearance.backgroundBlur) || 0));
      // Glass only exists while a picture (or preset) is behind the panel; the
      // plain theme keeps its solid surfaces.
      const glass = (percent, extra = {}) => ({
        ...(hasBackground ? {
          // A backdrop-filter here (and on every bubble) made Chromium drop
          // whole layers once the window went full screen. A denser translucent
          // wash reads almost the same over a picture without the GPU cost.
          background: `color-mix(in srgb, var(--dsw-alias-bg-base, #fff) ${Math.min(96, percent + 8)}%, transparent)`,
        } : {
          // Without a picture the panes still get a faint brand wash, so the
          // sidebar and header do not disappear into the thread background.
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 6%, transparent), transparent 210px)',
        }),
        ...extra,
      });

      // ── left: private chats, then groups ─────────────────────────────
      const conversationButton = row => {
        const isActive = row.scene === active;
        const accent = sceneAccent(row.scene);
        return h('button', {
          key: row.scene,
          type: 'button',
          className: 'dsh-to-qq-row',
          'data-active': isActive ? 'true' : 'false',
          onClick: () => setActive(row.scene),
          style: {
            textAlign: 'left',
            border: 'none',
            borderRadius: 11,
            padding: '9px 9px',
            cursor: 'pointer',
            color: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            fontSize: 12,
          },
        },
        h(SceneAvatar, { scene: row.scene, name: nameFor(row.scene), size: 38, ring: isActive }),
        h('span', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 } },
        h('span', {
          style: {
            fontWeight: isActive ? 650 : 520,
            fontSize: 12.5,
            letterSpacing: '-.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, nameFor(row.scene)),
        h('span', {
          style: {
            display: 'flex', alignItems: 'center', gap: 5, minWidth: 0,
            fontSize: 10.5, opacity: isActive ? 0.62 : 0.45, whiteSpace: 'nowrap',
          },
        },
        h('span', { style: { width: 4, height: 4, borderRadius: 99, background: accent, flex: '0 0 4px' } }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
          `${row.total} 条 · ${String(row.lastAt ?? '').slice(5, 16)}`))));
      };

      const section = (title, items) => (items.length === 0 ? null : h('div', {
        key: title,
        style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 3 },
      },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 9px 4px',
        },
      },
      h('span', {
        style: {
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '.09em',
          opacity: 0.42,
        },
      }, title),
      h('span', { style: { flex: 1, height: 1, background: PANEL_BORDER, opacity: 0.75 } }),
      h('span', { style: { fontSize: 10, opacity: 0.38, fontVariantNumeric: 'tabular-nums' } }, String(items.length))),
      items.map(conversationButton)));

      const rows = [
        section('私聊', shown.filter(row => kindOf(row.scene) === 'dm')),
        section('群聊', shown.filter(row => kindOf(row.scene) === 'group')),
      ].filter(item => item !== null);

      const leftPane = h('div', {
        style: {
          width: 276,
          flex: '0 0 276px',
          borderRight: `1px solid ${PANEL_BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          ...glass(76),
        },
      },
      h('div', { style: { padding: '16px 14px 12px', display: 'flex', alignItems: 'center', gap: 9 } },
      h('span', {
        style: {
          width: 30,
          height: 30,
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg,#4d6bfe,#7a5cf0)',
          color: '#fff',
          fontSize: 13.5,
          fontWeight: 700,
          boxShadow: '0 6px 14px rgba(77,107,254,.28)',
        },
      }, 'Q'),
      h('span', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
      h('span', { style: { fontSize: 13, fontWeight: 650, letterSpacing: '-.01em' } }, 'QQ 对话'),
      h('span', { style: { fontSize: 10, opacity: 0.42 } }, online ? '实时同步' : '等待连接')),
      h('span', {
        style: {
          marginLeft: 'auto', fontSize: 10.5, opacity: 0.55, padding: '2px 7px', borderRadius: 20,
          background: 'color-mix(in srgb, var(--dsw-alias-label-primary,#111) 6%, transparent)',
          flex: '0 0 auto',
        },
      }, `${scenes.length} 个`)),
      h('div', { style: { padding: '0 14px 12px', position: 'relative' } },
      h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round',
        style: {
          position: 'absolute', left: 24, top: '50%', transform: 'translateY(-50%)',
          opacity: 0.38, pointerEvents: 'none',
        },
      },
      h('circle', { cx: 11, cy: 11, r: 7 }),
      h('path', { d: 'M20 20l-3.5-3.5' })),
      h('input', {
        className: 'dsh-to-qq-search',
        value: query,
        onChange: event => setQuery(event.target.value),
        placeholder: '搜索会话',
        style: {
          width: '100%',
          boxSizing: 'border-box',
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 11,
          padding: '8px 10px 8px 31px',
          fontSize: 12,
          fontFamily: 'inherit',
          color: 'inherit',
          background: 'color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 72%, transparent)',
          outline: 'none',
        },
      })),
      h('div', {
        className: 'dsh-to-qq-scroll',
        style: { overflowY: 'auto', padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0 },
      },
      rows,
      rows.length === 0
        ? h('div', { style: { opacity: 0.5, padding: 16, fontSize: 12, textAlign: 'center' } }, scenes.length === 0 ? '还没有消息记录' : '没有匹配的会话')
        : null));

      // ── right: thread ────────────────────────────────────────────────
      const bubbles = messages.map((entry, index) => {
        const out = entry.direction === 'out';
        const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning !== '';
        const isOpen = open[index] === true;
        const translation = translations[index];
        const name = out ? '我' : String(entry.sender_name ?? '对方');
        const clock = String(entry.time_bj ?? '').slice(11, 16);
        const day = String(entry.time_bj ?? '').slice(0, 10);
        const previousDay = index === 0 ? '' : String(messages[index - 1]?.time_bj ?? '').slice(0, 10);
        const showDay = index === 0 ? day !== '' : day !== previousDay;

        const parts = [
          h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.55 } }, entry.text),
        ];
        if (hasReasoning) {
          parts.push(h('button', {
            type: 'button',
            onClick: () => toggleReasoning(index),
            style: {
              marginTop: 6,
              border: 'none',
              background: out ? 'rgba(255,255,255,.2)' : 'rgba(128,128,128,.16)',
              color: 'inherit',
              borderRadius: 20,
              padding: '2px 9px',
              fontSize: 11,
              cursor: 'pointer',
            },
          }, `推理 ${isOpen ? '▲' : '▼'}`));
        }
        if (isOpen) {
          const body = [];
          if (translation?.status === 'loading') body.push('翻译中…');
          else if (translation?.status === 'ok') body.push(translation.text);
          else body.push(entry.reasoning);
          if (translation?.status === 'error') body.push(h('div', { style: { marginTop: 6, opacity: 0.65 } }, `（翻译失败：${translation.text}）`));
          if (translation?.status === 'unavailable') body.push(h('div', { style: { marginTop: 6, opacity: 0.65 } }, `（自动翻译不可用：${translation.note || '无可用翻译路由'}）`));
          parts.push(h('div', {
            style: {
              marginTop: 7,
              padding: '8px 10px',
              borderRadius: 10,
              background: out ? 'rgba(0,0,0,.18)' : 'rgba(128,128,128,.1)',
              border: `1px solid ${out ? 'rgba(255,255,255,.18)' : PANEL_BORDER}`,
              fontFamily: PANEL_MONO,
              fontSize: 11.5,
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 340,
              overflowY: 'auto',
            },
          }, body));
        }

        const bubble = h('div', {
          style: {
            background: out
              ? 'linear-gradient(135deg,#4d6bfe,#6b7cff)'
              : hasBackground
                ? 'color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 90%, transparent)'
                : 'rgba(128,128,128,.13)',
            color: out ? '#fff' : 'inherit',
            borderRadius: 15,
            borderTopRightRadius: out ? 5 : 15,
            borderTopLeftRadius: out ? 15 : 5,
            padding: '9px 12px',
            border: !out && hasBackground ? `1px solid ${PANEL_BORDER}` : 'none',
            boxShadow: out ? '0 4px 12px rgba(40,60,180,.22)' : '0 1px 3px rgba(0,0,0,.06)',
            minWidth: 0,
          },
        }, parts);

        return h('div', {
          key: `${entry.msg_id}-${entry.time_bj}-${index}`,
          style: { display: 'flex', flexDirection: 'column', gap: 5 },
        },
        showDay ? h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'stretch', padding: '4px 0' },
        },
        h('span', { style: { flex: 1, height: 1, background: PANEL_BORDER, opacity: 0.8 } }),
        h('span', {
          style: {
            fontSize: 10.5, opacity: 0.45, padding: '2px 8px', borderRadius: 20,
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 55%, transparent)',
          },
        }, day),
        h('span', { style: { flex: 1, height: 1, background: PANEL_BORDER, opacity: 0.8 } })) : null,
        h('div', { style: { display: 'flex', flexDirection: out ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-start' } },
        h('span', {
          style: {
            width: 26,
            height: 26,
            borderRadius: 9,
            flex: '0 0 26px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            background: out ? 'rgba(77,107,254,.16)' : 'rgba(128,128,128,.16)',
            color: out ? '#3b53c9' : 'inherit',
            boxShadow: '0 1px 3px rgba(0,0,0,.06)',
          },
        }, out ? '我' : name.slice(0, 1)),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, maxWidth: '72%', alignItems: out ? 'flex-end' : 'flex-start' } },
        h('div', { style: { fontSize: 11, opacity: 0.45, padding: '0 2px' } }, `${name} · ${clock}`),
        bubble)));
      });

      const header = h('div', {
        style: {
          padding: '13px 18px',
          borderBottom: `1px solid ${PANEL_BORDER}`,
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          minHeight: 36,
          ...glass(68),
        },
      },
      active === null ? null : h(SceneAvatar, { scene: active, name: nameFor(active), size: 36, ring: true }),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
      h('span', {
        style: {
          fontSize: 14.5,
          fontWeight: 650,
          letterSpacing: '-.015em',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, active === null ? '—' : nameFor(active)),
      active === null ? null : h('span', {
        style: {
          fontSize: 10.5,
          padding: '2px 8px',
          borderRadius: 20,
          background: `${sceneAccent(active)}14`,
          color: sceneAccent(active),
          flex: '0 0 auto',
          fontWeight: 500,
        },
      }, kindOf(active) === 'group' ? '群聊' : '私聊'),
      h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 10.5,
          padding: '2px 8px',
          borderRadius: 20,
          background: online ? 'rgba(18,160,106,.12)' : 'rgba(192,57,43,.10)',
          color: online ? '#0d8a5b' : '#c0392b',
          flex: '0 0 auto',
        },
      },
      h(Dot, { color: online ? '#12a06a' : '#c0392b', pulse: state?.transport === 'connecting' || state?.transport === 'backoff' }),
      state === null ? '读取中' : (online ? '已连接' : String(state.transport ?? '离线')))),
      h('div', { style: { fontSize: 10.5, opacity: 0.42, display: 'flex', gap: 8, minWidth: 0 } },
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        active === null ? '选择一个会话' : loading ? '读取中…' : `${kindOf(active) === 'group' ? '群聊' : '私聊'} · ${messages.length} 条消息`),
      error === '' ? null : h('span', { style: { color: '#c0392b', opacity: 1 } }, error))),
      h('span', { style: { marginLeft: 'auto', fontSize: 10.5, opacity: 0.4, flex: '0 0 auto' } }, loading ? '' : `${messages.length} 条`));

      const thread = h('div', {
        onScroll,
        ref: scrollRef,
        className: 'dsh-to-qq-scroll',
        style: {
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowAnchor: 'none',
          padding: '18px 20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: hasBackground ? 'transparent' : 'linear-gradient(180deg, rgba(128,128,128,.045), rgba(0,0,0,0) 160px)',
        },
      },
      bubbles.length === 0
        ? h('div', { style: { margin: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, opacity: 0.55 } },
          h('span', {
            style: {
              width: 52, height: 52, borderRadius: 17, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg,#4d6bfe,#7a5cf0)', color: '#fff',
              fontSize: 22, fontWeight: 700, boxShadow: '0 8px 20px rgba(77,107,254,.28)',
            },
          }, 'Q'),
          h('span', { style: { fontSize: 12 } }, loading ? '正在读取会话…' : '这个会话还没有记录'))
        : bubbles);

      const pill = pending === 0 ? null : h('button', {
        type: 'button',
        onClick: jumpToLatest,
        style: {
          position: 'absolute',
          left: '50%',
          bottom: 18,
          transform: 'translateX(-50%)',
          border: 'none',
          borderRadius: 20,
          padding: '6px 14px',
          background: '#4d6bfe',
          color: '#fff',
          fontSize: 12,
          cursor: 'pointer',
          boxShadow: '0 6px 18px rgba(40,60,180,.35)',
          zIndex: 2,
        },
      }, `新消息 ×${pending}`);

      const threadWrap = h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, thread, pill);

      const rightPane = h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }, header, threadWrap);

      return h('div', {
        style: {
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          padding: 10,
          background: 'var(--dsw-alias-bg-base, #fff)',
        },
      },
      h('div', {
        style: {
          position: 'relative',
          display: 'flex',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: 18,
          border: `1px solid ${PANEL_BORDER}`,
          boxShadow: '0 18px 44px rgba(15,23,42,.12)',
          background: hasBackground
            ? 'var(--dsw-alias-bg-base, #fff)'
            : 'linear-gradient(150deg, color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 7%, var(--dsw-alias-bg-base, #fff)), var(--dsw-alias-bg-base, #fff) 48%, color-mix(in srgb, #7a5cf0 5%, var(--dsw-alias-bg-base, #fff)))',
          color: 'var(--dsw-alias-label-primary, #1c1f24)',
          fontSize: 13,
        },
      },
      hasBackground ? h('div', {
        style: {
          position: 'absolute', inset: 0, ...backgroundCss,
          backgroundSize: 'cover', backgroundPosition: 'center',
          filter: blur > 0 ? `blur(${blur}px)` : 'none',
          transform: blur > 0 ? 'scale(1.06)' : 'none',
        },
      }) : null,
      hasBackground ? h('div', {
        style: {
          position: 'absolute', inset: 0,
          background: `color-mix(in srgb, var(--dsw-alias-bg-base, #fff) ${dim}%, transparent)`,
        },
      }) : null,
      h('div', {
        style: { position: 'relative', zIndex: 1, display: 'flex', height: '100%', minHeight: 0, width: '100%' },
      }, leftPane, rightPane)));
    };

    /** Slot entry for the settings surface. */
    const SettingsSection = () => h(SettingsBoundary, null, h(SettingsPage));

    /** Register the main panel, its sidebar row and the settings section. */
    const apply = ctx => {
      // The conversation lives in the main area; no floating bubble exists any more.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_KEY,
        order: 40,
      }, QqPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: 12,
        label: () => 'QQ 对话',
      }, QqPanelIcon));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-to-qq',
        label: 'QQ 桥接',
        order: 60,
      }, SettingsSection));
    };

    return { name: 'dsh-to-qq-client', inject: ['slots'], apply };
  },
});








