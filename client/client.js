/**
 * dsh-to-qq — browser half.
 *
 * A floating companion in `shell.overlay`: drag it anywhere, click it to expand
 * the QQ panel, double-click to collapse. No build step — the DSH client module
 * loader hands us React, and this file writes elements directly.
 *
 * The companion visual is intentionally a placeholder: `PetStage` below renders
 * an inline SVG, and a real animation clip can replace it without touching the
 * drag, panel, or positioning code.
 */
window.__ModuleLoader__.load({
  id: 'dsh-to-qq',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // One tiny stylesheet for the status dot pulse.
    if (typeof document !== 'undefined' && document.getElementById('dsh-to-qq-style') === null) {
      const sheet = document.createElement('style');
      sheet.id = 'dsh-to-qq-style';
      sheet.textContent = '@keyframes dshToQqPulse{0%,100%{opacity:1}50%{opacity:.3}}';
      document.head.appendChild(sheet);
    }

    /** Overlay id used for slot registration and CSS scoping. */
    const SLOT_ID = 'dsh-to-qq-pet';
    /** localStorage key for the remembered position and panel state. */
    const STORE_KEY = 'dsh-to-qq:overlay';

    /** Read the remembered overlay state. */
    const readState = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '{}');
        return {
          x: Number.isFinite(parsed.x) ? parsed.x : window.innerWidth - 120,
          y: Number.isFinite(parsed.y) ? parsed.y : window.innerHeight - 180,
          open: parsed.open === true,
        };
      } catch {
        return { x: window.innerWidth - 120, y: window.innerHeight - 180, open: false };
      }
    };

    /** Persist the overlay state. */
    const writeState = state => {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
      } catch {
        // Private mode: position simply is not remembered.
      }
    };

    /** Keep the bubble fully inside the viewport. */
    const clamp = (x, y, size) => ({
      x: Math.max(8, Math.min(x, window.innerWidth - size - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - size - 8)),
    });

    /** Inline companion artwork: a soft whale-ish blob, no external asset. */
    const PetStage = props => h(
      'svg',
      { width: props.size, height: props.size, viewBox: '0 0 96 96', 'aria-hidden': 'true' },
      h('defs', null,
        h('radialGradient', { id: 'dsh-to-qq-body', cx: '35%', cy: '30%', r: '80%' },
          h('stop', { offset: '0', stopColor: '#7aa2ff' }),
          h('stop', { offset: '1', stopColor: '#3b5bdb' }))),
      h('ellipse', { cx: 48, cy: 52, rx: 32, ry: 30, fill: 'url(#dsh-to-qq-body)' }),
      h('circle', { cx: 37, cy: 47, r: 4.2, fill: '#fff' }),
      h('circle', { cx: 59, cy: 47, r: 4.2, fill: '#fff' }),
      h('circle', { cx: 38, cy: 48, r: 2.1, fill: '#16213e' }),
      h('circle', { cx: 60, cy: 48, r: 2.1, fill: '#16213e' }),
      h('path', { d: 'M40 62q8 7 16 0', stroke: '#16213e', strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' }),
      h('path', { d: 'M24 34q6-10 18-9', stroke: '#ffffff', strokeWidth: 3, fill: 'none', opacity: 0.55, strokeLinecap: 'round' }),
    );

    /** Human label for a scene key. */
    const sceneLabel = scene => (scene.startsWith('group:') ? `群 ${scene.slice(6)}` : `私聊 ${scene.slice(3)}`);

    /**
     * Locate the dsh-pet element in this page.
     *
     * The pet's animation clips are served from `/dsh-pet-7340/thumb/`, so the
     * video carrying such a source is the pet. Returns viewport pixels.
     *
     * @returns {{ x: number, y: number } | null} Pet centre, or null when absent.
     */
    const findPetAnchor = () => {
      const videos = document.querySelectorAll('video');
      for (const video of videos) {
        const source = video.currentSrc || video.src || '';
        if (!source.includes('/dsh-pet-7340/')) continue;
        const rect = video.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return null;
    };

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

    /** Scene list and message log, loaded from the bridge. */
    const PanelBody = props => {
      const [state, setState] = React.useState(null);
      const [active, setActive] = React.useState(null);
      const [messages, setMessages] = React.useState([]);
      const [expanded, setExpanded] = React.useState(null);
      const [translations, setTranslations] = React.useState({});
      const [error, setError] = React.useState('');
      const scrollRef = React.useRef(null);

      // Always land on the newest message, exactly like a chat app.
      React.useEffect(() => {
        const element = scrollRef.current;
        if (element !== null) element.scrollTop = element.scrollHeight;
      }, [messages, expanded]);

      /** Expand one reply's reasoning, translating it on first open. */
      const toggleReasoning = index => {
        const next = expanded === index ? null : index;
        setExpanded(next);
        if (next === null) return;
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

      React.useEffect(() => {
        if (props.open !== true) return undefined;
        let cancelled = false;
        setError('');
        getJson('/dsh-to-qq/api/state')
          .then(data => {
            if (!cancelled) setState(data);
          })
          .catch(reason => {
            if (!cancelled) setError(String(reason?.message ?? reason));
          });
        return () => {
          cancelled = true;
        };
      }, [props.open]);

      React.useEffect(() => {
        if (active === null) {
          setMessages([]);
          return undefined;
        }
        let cancelled = false;
        getJson(`/dsh-to-qq/api/messages?scene=${encodeURIComponent(active)}&limit=60`)
          .then(data => {
            if (!cancelled) setMessages(data.messages ?? []);
          })
          .catch(reason => {
            if (!cancelled) setError(String(reason?.message ?? reason));
          });
        return () => {
          cancelled = true;
        };
      }, [active]);

      const scrollStyle = { overflowY: 'auto', maxHeight: 320, display: 'flex', flexDirection: 'column', gap: 6 };

      if (active !== null) {
        return h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
          h('button', {
            type: 'button',
            onClick: () => setActive(null),
            style: { alignSelf: 'flex-start', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', opacity: 0.7, padding: 0, fontSize: 12 },
          }, '← 返回'),
          messages.length === 0
            ? h('div', { style: { opacity: 0.55 } }, '这个会话还没有记录。')
            : h('div', { ref: scrollRef, style: scrollStyle },
              messages.map((entry, index) => {
                const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning !== '';
                const isOpen = expanded === index;
                const translation = translations[index];
                return h('div', {
                  key: `${entry.msg_id}-${index}-${entry.time_bj}`,
                  onClick: hasReasoning ? () => toggleReasoning(index) : undefined,
                  style: {
                    alignSelf: entry.direction === 'out' ? 'flex-end' : 'flex-start',
                    maxWidth: '88%',
                    background: entry.direction === 'out' ? 'rgba(77,107,254,.14)' : 'rgba(128,128,128,.14)',
                    borderRadius: 10,
                    padding: '6px 9px',
                    cursor: hasReasoning ? 'pointer' : 'default',
                  },
                },
                h('div', { style: { fontSize: 11, opacity: 0.55, marginBottom: 2 } },
                  `${entry.direction === 'out' ? 'DSH' : entry.sender_name} · ${String(entry.time_bj).slice(11, 16)}`),
                h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, entry.text),
                hasReasoning
                  ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, isOpen ? '收起推理 ▲' : '查看推理 ▼')
                  : null,
                isOpen
                  ? h('div', {
                    style: {
                      marginTop: 6,
                      paddingTop: 6,
                      fontSize: 11,
                      opacity: 0.75,
                      borderTop: '1px dashed rgba(128,128,128,.35)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  },
                  translation?.status === 'ok'
                    ? translation.text
                    : translation?.status === 'loading'
                      ? '翻译中…'
                      : entry.reasoning,
                  translation?.status === 'error'
                    ? h('div', { style: { opacity: 0.6, marginTop: 4 } }, `（翻译失败：${translation.text}）`)
                    : null,
                  translation?.status === 'unavailable'
                    ? h('div', { style: { opacity: 0.55, marginTop: 4 } }, `（自动翻译不可用：${translation.note || '无可用翻译路由'}）`)
                    : null)
                  : null);
              })));
      }

      return h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { fontSize: 12, opacity: 0.7 } },
          state === null ? '读取状态…' : `连接：${state.transport} · 会话 ${state.scenes.length}`),
        error === '' ? null : h('div', { style: { color: '#c0392b', fontSize: 12 } }, error),
        h('div', { style: scrollStyle },
          (state?.scenes ?? []).map(row => h('button', {
            key: row.scene,
            type: 'button',
            onClick: () => setActive(row.scene),
            style: {
              textAlign: 'left', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
              background: 'rgba(128,128,128,.10)', color: 'inherit', display: 'flex',
              flexDirection: 'column', gap: 2, fontSize: 12,
            },
          },
          h('span', { style: { fontWeight: 600 } }, sceneLabel(row.scene)),
          h('span', { style: { opacity: 0.6 } }, `${row.total} 条 · 最后 ${String(row.lastAt).slice(5, 16)}`)))),
        state !== null && state.scenes.length === 0
          ? h('div', { style: { opacity: 0.55, fontSize: 12 } }, '还没有消息记录，先在 QQ 里说句话吧。')
          : null);
    };

    /** The panel shell. Docked next to the pet when integrated, anchored to the bubble otherwise. */
    const PetPanel = props => h('div', {
      style: {
        position: props.rect ? 'fixed' : 'absolute',
        top: props.rect ? props.rect.top : 'auto',
        left: props.rect ? props.rect.left : props.docked ? 'auto' : 0,
        right: props.rect ? 'auto' : props.docked ? 0 : 'auto',
        bottom: props.rect ? 'auto' : props.docked ? 0 : 76,
        width: 320,
        maxHeight: 'min(70vh, 460px)',
        display: props.open ? 'flex' : 'none',
        flexDirection: 'column',
        borderRadius: 14,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1c1f24)',
        boxShadow: '0 18px 48px rgba(0,0,0,.22)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
        fontFamily: 'system-ui, -apple-system, "Microsoft YaHei UI", sans-serif',
        fontSize: 13,
        zIndex: 61,
        transform: props.rect ? (props.entered ? 'translateX(0) scale(1)' : `translateX(${props.fromX ?? 0}px) scale(.96)`) : undefined,
        opacity: props.rect ? (props.entered ? 1 : 0) : undefined,
        transition: props.rect
          ? 'transform 180ms ease-out, opacity 180ms ease-out, left 240ms linear, top 240ms linear'
          : undefined,
      },
    },
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
        fontWeight: 600,
      },
    },
    h('span', null, 'DSH ⇄ QQ'),
    h('button', {
      type: 'button',
      onClick: () => props.onClose(),
      style: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, lineHeight: 1, color: 'inherit', opacity: 0.6 },
      'aria-label': 'close',
    }, '×')),
    h(PanelBody, { open: props.open }));

    /** Floating companion plus its panel. */
    const PetOverlay = () => {
      const initial = React.useRef(readState());
      const [position, setPosition] = React.useState({ x: initial.current.x, y: initial.current.y });
      const [open, setOpen] = React.useState(initial.current.open);
      const [petReady, setPetReady] = React.useState(false);
      const drag = React.useRef(null);

      React.useEffect(() => {
        writeState({ x: position.x, y: position.y, open });
      }, [position, open]);

      React.useEffect(() => {
        const onResize = () => setPosition(previous => clamp(previous.x, previous.y, 64));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // The desktop pet's right-click menu asks us to open; poll its click count.
      const lastPetClick = React.useRef(null);
      React.useEffect(() => {
        let cancelled = false;
        const tick = async () => {
          try {
            const data = await getJson('/dsh-to-qq/api/state');
            if (cancelled) return;
            setPetReady(data.petReady === true);
            const clicks = Number(data.petClicks ?? 0);
            if (lastPetClick.current === null) lastPetClick.current = clicks;
            else if (clicks !== lastPetClick.current) {
              lastPetClick.current = clicks;
              setOpen(true);
            }
          } catch {
            // The bridge may be restarting; the next tick retries.
          }
        };
        void tick();
        const timer = window.setInterval(() => void tick(), 4000);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, []);

      const onPointerDown = event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y, moved: 0 };
      };

      const onPointerMove = event => {
        const current = drag.current;
        if (current === null) return;
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        current.moved = Math.max(current.moved, Math.abs(dx) + Math.abs(dy));
        setPosition(clamp(current.originX + dx, current.originY + dy, 64));
      };

      const onPointerUp = () => {
        const current = drag.current;
        drag.current = null;
        if (current !== null && current.moved < 6) setOpen(value => !value);
      };

      // Follow the pet: poll its normalized position while the panel is open.
      const [pose, setPose] = React.useState(null);
      const [entered, setEntered] = React.useState(false);

      React.useEffect(() => {
        if (!petReady || !open) return undefined;
        let cancelled = false;
        const load = async () => {
          // An in-page pet is found by DOM; a desktop pet is reported by the host.
          const anchor = findPetAnchor();
          if (anchor !== null) {
            if (!cancelled) setPose({ x: anchor.x, y: anchor.y });
            return;
          }
          try {
            const data = await getJson('/dsh-to-qq/api/pose');
            const nx = Number(data?.x);
            const ny = Number(data?.y);
            if (!cancelled && Number.isFinite(nx) && Number.isFinite(ny)) {
              // Normalized screen coordinates -> viewport pixels of this window.
              const screenWidth = window.screen?.width ?? window.innerWidth;
              const screenHeight = window.screen?.height ?? window.innerHeight;
              setPose({
                x: nx * screenWidth - (window.screenX ?? 0),
                y: ny * screenHeight - (window.screenY ?? 0),
              });
            }
          } catch {
            // Keep the previous anchor; the pet may be moving.
          }
        };
        void load();
        const timer = window.setInterval(() => void load(), 400);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [petReady, open]);

      React.useEffect(() => {
        if (!petReady || !open) {
          setEntered(false);
          return undefined;
        }
        setEntered(false);
        const raf = window.requestAnimationFrame(() => setEntered(true));
        return () => window.cancelAnimationFrame(raf);
      }, [petReady, open]);

      // Place the panel beside the pet, on whichever side has room, and never
      // park it on top of a control: the window buttons and other interactive
      // elements are probed before a position is accepted.
      const layout = React.useMemo(() => {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const panelW = 320;
        const panelH = Math.min(height * 0.7, 460);
        const px = pose === null ? width - 96 : pose.x;
        const py = pose === null ? height - 96 : pose.y;
        const roomRight = width - px;
        // A pet outside the window pulls the panel to that edge instead of the middle.
        const toRight = px < 0 || (px <= width && roomRight >= panelW + 56);
        const clampX = value => Math.min(Math.max(value, 12), width - panelW - 12);
        const clampY = value => Math.min(Math.max(value, 12), height - panelH - 12);
        const besideLeft = clampX(toRight ? px + 48 : px - panelW - 48);
        const besideTop = clampY(py - panelH / 2);
        const mirroredLeft = clampX(toRight ? px - panelW - 56 : px + 56);

        /**
         * Whether a position would sit on top of something clickable.
         *
         * @param {number} left Candidate left.
         * @param {number} top Candidate top.
         * @returns {boolean} True when the spot is taken.
         */
        const blocksUi = (left, top) => {
          // Reserved: the window controls in the top-right corner.
          if (left + panelW > width - 220 && top < 48) return true;
          const probes = [
            [left + 10, top + 10],
            [left + panelW - 10, top + 10],
            [left + 10, top + panelH - 10],
            [left + panelW - 10, top + panelH - 10],
            [left + panelW / 2, top + 8],
          ];
          for (const [x, y] of probes) {
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const element = document.elementFromPoint(x, y);
            if (element?.closest('button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]') !== null
              && element?.closest('button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]') !== undefined) {
              return true;
            }
          }
          return false;
        };

        const candidates = [
          { left: besideLeft, top: besideTop },
          { left: besideLeft, top: clampY(64) },
          { left: besideLeft, top: clampY(height - panelH - 64) },
          { left: mirroredLeft, top: besideTop },
          { left: clampX(width - panelW - 16), top: clampY(height - panelH - 64) },
          { left: clampX(16), top: clampY(64) },
        ];
        const chosen = candidates.find(candidate => !blocksUi(candidate.left, candidate.top)) ?? candidates[0];
        return { left: chosen.left, top: chosen.top, fromX: chosen.left >= px ? -28 : 28 };
      }, [pose]);

      // With dsh-pet present the pet owns the launcher: no bubble, panel follows it.
      if (petReady) {
        if (!open) return null;
        return h(PetPanel, {
          open: true,
          rect: layout,
          entered,
          fromX: layout.fromX,
          onClose: () => setOpen(false),
        });
      }

      return h('div', { style: { position: 'fixed', left: position.x, top: position.y, zIndex: 60, width: 64, height: 64 } },
        h(PetPanel, { open, onClose: () => setOpen(false) }),
        h('button', {
          type: 'button',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          title: 'DSH ⇄ QQ',
          style: {
            width: 64, height: 64, borderRadius: '50%', border: 'none', padding: 0,
            cursor: 'grab', background: 'transparent',
            filter: 'drop-shadow(0 10px 18px rgba(59,91,219,.35))',
            animation: 'dsh-to-qq-breathe 3.6s ease-in-out infinite',
            touchAction: 'none',
          },
        }, h(PetStage, { size: 64 })));
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
          { path: 'connection.botUin', label: '机器人 QQ 号（0 = 自动识别）', type: 'number' },
          { path: 'connection.tokenEnv', label: 'token 环境变量名', type: 'text', placeholder: 'QQ_BOT_TOKEN' },
          { path: 'connection.autoStart', label: '自动启动 SnowLuma', type: 'checkbox' },
          { path: 'ui.pet', label: '与 dsh-pet 联动', type: 'checkbox' },
          { path: 'ui.petId', label: '宠物 id', type: 'text', placeholder: 'main' },
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
          {
            path: 'output.style',
            label: '图片样式',
            type: 'select',
            options: [
              { value: 'light', label: '白底黑字' },
              { value: 'dark', label: '暗色' },
              { value: 'bubble', label: '仿 QQ 气泡' },
            ],
          },
          { path: 'output.fontSize', label: '字号', type: 'number' },
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
      { id: '表情', title: '表情', custom: 'stickers' },
      { id: '模型', title: '模型', custom: 'models' },
      { id: '用量', title: '用量', custom: 'usage' },
      { id: '档案', title: '档案', custom: 'archive' },
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
      'ui.pet': '与 dsh-pet 联动：菜单、气泡、工作状态',
      'ui.petId': 'dsh-pet 实例 id，一般不用改',
      'voice.enabled': '收到语音时自动转成文字',
      'voice.language': '识别语言，如 zh / en',
      'voice.command': '本地识别命令，{input} {language} 占位；留空不用',
      'archive.retentionDays': '档案保留天数，0 = 永久',
      'archive.mediaRetentionDays': '图片/语音/文件保留天数，通常比档案短',
      'connection.botUin': '填了就只接受这个号的事件；0 = 从第一条事件学习后锁定',
      'connection.tokenEnv': '把 token 放进这个环境变量，config.json 里就不留明文（重启生效）',
      'archive.media': '把收到的图片/转发图存到本地',
    };

    /** One settings row: label and hint on the left, control on the right. */
    /** One settings row: label and hint on the left, control on the right. */
    const SettingsRow = props => {
      const { field, value, onChange, hint, first } = props;
      const common = {
        value: field.type === 'list'
          ? (Array.isArray(value) ? value.map(item => (typeof item === 'object' && item !== null ? item.qq : item)).join(', ') : '')
          : field.type === 'checkbox' ? undefined : (value ?? ''),
        placeholder: field.placeholder ?? '',
        onChange: event => {
          const raw = event.target.value;
          if (field.type === 'number') onChange(Number(raw));
          else if (field.type === 'list') {
            const numbers = raw.split(',').map(part => Number(part.trim())).filter(part => Number.isInteger(part) && part > 0);
            onChange(field.kind === 'admin' ? numbers.map(qq => ({ qq, name: '', addedAt: Date.now() })) : numbers);
          } else onChange(raw);
        },
        style: field.type === 'checkbox'
          ? { width: 17, height: 17, accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)', cursor: 'pointer' }
          : { ...UI.input, width: field.type === 'number' ? 120 : '100%' },
      };
      const control = field.type === 'select'
        ? h(Select, { value: value ?? '', options: field.options, onChange })
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
                : `${today.turns} 轮（谷时 ${today.offPeakTurns ?? 0}） · 输入 ${today.input} / 输出 ${today.output} / 缓存命中 ${today.cache}（${pct(today.cacheRate)}） · ${money(today.cost)}`)),
          h('button', { type: 'button', onClick: load, style: UI.ghost }, '刷新')),
        h('div', { style: { ...UI.muted, margin: '6px 0 10px' } },
          data?.prices !== undefined && data.prices.input === 0 && data.prices.output === 0 && data.prices.cache === 0
            ? '未配置单价，只显示 token。去「模型」页签填 ¥/百万 token。'
            : ''),
        data?.recent === undefined || data.recent.length === 0
          ? h('div', { style: UI.muted }, '还没有记录。下一轮对话后这里会出现数据。')
          : h('div', { style: { fontSize: 11.5, lineHeight: 1.9 } },
            h('div', { style: { ...UI.muted, display: 'grid', gridTemplateColumns: '1.4fr .8fr .7fr .7fr .6fr .6fr', gap: 8 } },
              h('span', { key: 'a' }, '场景'), h('span', { key: 'b' }, '时间'),
              h('span', { key: 'c' }, '输入'), h('span', { key: 'd' }, '输出'),
              h('span', { key: 'e' }, '缓存'), h('span', { key: 'f' }, '费用')),
            data.recent.slice(0, 15).map(row => h('div', {
              key: `${row.scene}-${row.startedAt}`,
              style: { display: 'grid', gridTemplateColumns: '1.4fr .8fr .7fr .7fr .6fr .6fr', gap: 8 },
            },
              h('span', { key: 'a' }, row.scene),
              h('span', { key: 'b' }, `${new Date(row.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}${row.offPeak ? ' 谷' : ''}`),
              h('span', { key: 'c' }, String(row.input)),
              h('span', { key: 'd' }, String(row.output)),
              h('span', { key: 'e' }, pct(row.cacheRate)),
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

      const applyConfig = next => {
        setConfig(next);
        setSavedJson(JSON.stringify(next));
      };

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
        : active.custom === 'stickers'
          ? [h(StickerBoard, { key: 'stickers' })]
        : active.custom === 'usage'
          ? [h(UsageBox, { key: 'usage' })]
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
              h('div', { key: 'prices', style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                fieldRow({ path: 'models.inputPrice', label: '输入 ¥/M', type: 'number' }),
                fieldRow({ path: 'models.outputPrice', label: '输出 ¥/M', type: 'number' }),
                fieldRow({ path: 'models.cachePrice', label: '缓存 ¥/M', type: 'number' })),
                fieldRow({ path: 'models.offPeakDiscount', label: '空闲折扣 (0-1)', type: 'number' }),
                fieldRow({ path: 'models.peakWindows', label: '高峰时段', type: 'text', placeholder: '09:00-12:00,14:00-18:00' }),
                fieldRow({ path: 'models.peakHolidays', label: '节假日(YYYY-MM-DD, 逗号)', type: 'text' }),
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

    /** Slot entry for the settings surface. */
    const SettingsSection = () => h(SettingsBoundary, null, h(SettingsPage));

    /** Register the overlay and the breathing keyframes. */
    const apply = ctx => {
      ctx.effect(() => {
        if (document.getElementById('dsh-to-qq-keyframes') === null) {
          const style = document.createElement('style');
          style.id = 'dsh-to-qq-keyframes';
          style.textContent = '@keyframes dsh-to-qq-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}';
          document.head.appendChild(style);
          return () => style.remove();
        }
        return () => {};
      }, 'dsh-to-qq: keyframes');

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: SLOT_ID,
        order: 40,
      }, PetOverlay));

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








