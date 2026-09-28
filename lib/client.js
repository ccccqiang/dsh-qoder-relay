window.__ModuleLoader__.load({
  id: "dsh-qoder-relay",
  factory: (require) => {
    /* dsh-qoder-relay — 浏览器半边
     *
     * 提供「Qoder CN」设置页：登录、状态、模型列表、接入地址。
     *
     * ── 手写而不用构建链 ──────────────────────────────────────────
     * DSH 的 client bundle 契约就是这一次 __ModuleLoader__.load 调用。
     * react / react-dom 由加载器提供，不需要打包。所以手写纯 JS +
     * React.createElement（不用 JSX）就够，省掉 tsdown + vite 整套。
     * 注意 window.__ModuleLoader__.load( 必须是文件第一条语句。
     *
     * ── 与 host 的通信：走网关自己的 HTTP，不用 DSH 服务协议 ──────
     * host 端通过 webserver/index-inject 注入 __QODER_RELAY_CONFIG__
     * （含 baseURL）。登录动作调网关的 /auth/* 端点。
     * 早先尝试 ctx.set("qoderRelay", ...) 会抛
     * "cannot set property without provide"，并让整个插件激活失败、DSH 打不开。
     */
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useRef, useCallback } = react;

    /* ─────────── 配置（由 host 注入）─────────── */
    function readCfg() {
      const g = (typeof window !== "undefined" && window.__QODER_RELAY_CONFIG__) || {};
      return {
        baseURL: g.baseURL || "http://127.0.0.1:8788",
        apiKey: g.apiKey || "",
        configDir: g.configDir || ""
      };
    }

    /** 调网关端点。返回解析后的 JSON，失败返回 { ok:false, message }。 */
    async function api(path, init) {
      const cfg = readCfg();
      const headers = Object.assign({ "Accept": "application/json" }, (init && init.headers) || {});
      if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
      if (init && init.body) headers["Content-Type"] = "application/json";
      try {
        const r = await fetch(cfg.baseURL + path, Object.assign({}, init, { headers }));
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { message: text }; }
        if (!r.ok) return Object.assign({ ok: false }, data, { httpStatus: r.status });
        return data;
      } catch (e) {
        return { ok: false, reason: "gateway-unreachable", message: "网关不可达：" + ((e && e.message) || String(e)) };
      }
    }

    /* ─────────── 样式 ─────────── */
    const CSS_TAG = "dsh-qoder-relay/settings.css";
    const CSS = [
      ".qr-wrap{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;max-width:760px}",
      ".qr-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px}",
      ".qr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".qr-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}",
      ".qr-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}",
      ".qr-muted{font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.8}",
      ".qr-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid transparent}",
      ".qr-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
      ".qr-badge-bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".qr-badge-wait{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-secondary)}",
      ".qr-dot{width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".qr-btn{font-size:13px;padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-secondary);background:transparent;color:var(--dsw-alias-label-primary)}",
      ".qr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.1))}",
      ".qr-btn:disabled{opacity:.45;cursor:default}",
      ".qr-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-primary,#fff);border-color:var(--dsw-alias-label-primary)}",
      ".qr-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-secondary);border-radius:6px;padding:8px 10px;word-break:break-all;user-select:all}",
      ".qr-link{color:var(--dsw-alias-label-primary);text-decoration:underline;word-break:break-all}",
      ".qr-models{display:flex;flex-wrap:wrap;gap:6px}",
      ".qr-chip{font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;padding:3px 9px;border-radius:6px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-secondary);color:var(--dsw-alias-label-secondary)}",
      ".qr-pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:17px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-secondary);border-radius:6px;padding:10px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0;color:var(--dsw-alias-label-secondary)}",
      ".qr-steps{margin:0;padding-left:18px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}"
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-qoder-relay";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ─────────── 小组件 ─────────── */
    function Badge(props) {
      return h("span", { className: "qr-badge qr-badge-" + (props.kind || "wait") },
        h("span", { className: "qr-dot" }), props.children);
    }
    function Btn(props) {
      return h("button", {
        type: "button",
        className: "qr-btn" + (props.primary ? " qr-btn-primary" : ""),
        disabled: props.disabled,
        onClick: props.onClick
      }, props.children);
    }

    /* ─────────── 主面板 ─────────── */
    function QoderPanel() {
      const [status, setStatus] = useState({ phase: "idle" });
      const [login, setLogin] = useState({ active: false });
      const [busy, setBusy] = useState(false);
      const [showLog, setShowLog] = useState(false);
      const [upd, setUpd] = useState({ phase: "idle" });
      const [showNotes, setShowNotes] = useState(false);
      const timerRef = useRef(null);

      const checkUpdate = useCallback(async (force) => {
        setUpd({ phase: "checking" });
        const r = await api("/update/check" + (force ? "?force=1" : ""));
        if (!r || r.ok !== true) {
          setUpd({ phase: "error", message: (r && r.message) || "检查失败。" });
          return;
        }
        setUpd({ phase: "ready", data: r });
      }, []);

      // 一键更新：走宿主 pluginManager.installBundle（host 半边暴露的 POST /qoder-relay/update）。
      // 注意这条路不经过网关，是宿主 Web 服务自己的路由，所以用原生 fetch 而不是 api()。
      const [apply, setApply] = useState({ phase: "idle" });
      const doUpdate = useCallback(async (spec) => {
        setApply({ phase: "running" });
        try {
          const r = await fetch("/qoder-relay/update", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(spec ? { spec } : {})
          });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j) {
            setApply({ phase: "error", message: "更新请求失败：HTTP " + r.status });
            return;
          }
          if (j.ok) setApply({ phase: "done", spec: j.spec });
          else setApply({ phase: "error", message: j.error || "安装未成功，详见宿主日志。" });
        } catch (e) {
          setApply({ phase: "error", message: (e && e.message) ? e.message : String(e) });
        }
      }, []);

      const refresh = useCallback(async () => {
        setBusy(true);
        setStatus({ phase: "loading" });
        const r = await api("/auth/status");
        if (r && r.ok === false && r.reason === "gateway-unreachable") {
          setStatus({ phase: "error", message: r.message });
        } else {
          setStatus({ phase: "ready", data: r });
        }
        setBusy(false);
      }, []);

      useEffect(() => { refresh(); }, [refresh]);
      // 页面打开时静默查一次更新（结果缓存 10 分钟，不会频繁打 GitHub）
      useEffect(() => { checkUpdate(false); }, [checkUpdate]);

      useEffect(() => {
        if (!login.active) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          return;
        }
        timerRef.current = setInterval(async () => {
          const s = await api("/auth/login/state");
          setLogin((prev) => Object.assign({}, prev, s));
          if (s.success || (s.done && !s.url)) {
            clearInterval(timerRef.current); timerRef.current = null;
            setTimeout(refresh, 800);
          }
        }, 1200);
        return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
      }, [login.active, refresh]);

      const onLogin = useCallback(async () => {
        setBusy(true);
        const r = await api("/auth/login", { method: "POST" });
        setBusy(false);
        if (!r || r.ok === false) {
          setStatus({ phase: "error", message: (r && r.message) || "启动登录失败。" });
          return;
        }
        setLogin({ active: true, url: r.url || null, success: false, done: false });
      }, []);

      const onCancel = useCallback(async () => {
        await api("/auth/login/cancel", { method: "POST" });
        setLogin({ active: false });
        refresh();
      }, [refresh]);

      const children = [];
      const cfg = readCfg();

      children.push(h("div", { className: "qr-card", key: "head" },
        h("h3", { className: "qr-title" }, "Qoder CN 额度网关"),
        h("p", { className: "qr-desc" },
          "把 Qoder CN 订阅额度暴露为本地 OpenAI 兼容服务，供 DSH 模型选择器使用。" +
          "网关随 DSH 自动启停；Qoder 桌面端无需运行。")
      ));

      // 状态
      const st = status.phase === "ready" ? status.data : null;
      if (status.phase === "idle" || status.phase === "loading") {
        children.push(h("div", { className: "qr-card", key: "st" },
          h("div", { className: "qr-row" }, h(Badge, { kind: "wait" }, "检测中…"))));
      } else if (status.phase === "error") {
        children.push(h("div", { className: "qr-card", key: "st" },
          h("div", { className: "qr-row" }, h(Badge, { kind: "bad" }, "不可用")),
          h("p", { className: "qr-desc" }, status.message || "未知错误")));
      } else if (st) {
        const ok = st.ok === true;
        const rows = [h("div", { className: "qr-row", key: "r1" },
          h(Badge, { kind: ok ? "ok" : "bad" }, ok ? "可用" : "未就绪"),
          h("span", { className: "qr-muted" },
            ok ? ("已加载 " + (st.models || []).length + " 个模型") : (st.message || st.reason || "")))];
        if (!st.ok && st.configDir) {
          // 只在"未就绪"时显示路径 —— 已就绪时那是排错信息，不是日常信息。
          rows.push(h("div", { className: "qr-muted", key: "r2" }, "配置目录：" + st.configDir));
        }
        rows.push(h("div", { className: "qr-row", key: "r3" },
          h(Btn, { onClick: refresh, disabled: busy }, busy ? "检测中…" : "重新检测")));
        children.push(h("div", { className: "qr-card", key: "st" }, ...rows));
      }

      // 登录
      if (login.active) {
        const finished = login.success || login.done;
        children.push(h("div", { className: "qr-card", key: "login" },
          h("h4", { className: "qr-title" },
            login.success ? "登录成功" : (login.done ? "登录流程已结束" : "等待浏览器授权")),
          h("p", { className: "qr-desc" },
            login.success
              ? "凭证已保存。可以点「完成」返回。"
              : (login.url
                  ? "在浏览器打开下面的链接，用你的 Qoder 账号完成授权。"
                  : "正在获取授权链接…（首次可能需要几秒）")),
          login.url ? h("a", { className: "qr-link", href: login.url, target: "_blank", rel: "noreferrer" }, login.url) : null,
          h("div", { className: "qr-row" },
            h(Btn, { onClick: () => setShowLog(!showLog) }, showLog ? "隐藏输出" : "查看输出"),
            finished ? h(Btn, { primary: true, onClick: () => { setLogin({ active: false }); refresh(); } }, "完成")
                     : h(Btn, { onClick: onCancel }, "取消")),
          h("pre", { className: "qr-pre", style: showLog ? {} : { display: "none" } }, login.tail || "")
        ));
      } else {
        const loggedIn = !!(st && st.loggedIn);
        const rows = [];

        if (loggedIn) {
          rows.push(h("div", { className: "qr-row", key: "who" },
            h(Badge, { kind: "ok" }, "已登录"),
            st.name ? h("span", { className: "qr-muted" }, st.name) : null));
          rows.push(h("p", { className: "qr-muted", key: "d1" },
            "凭证由 Qoder CLI 维护" + (st.snapshotAt ? " · 快照 " + st.snapshotAt : "")));
        } else {
          rows.push(h("p", { className: "qr-desc", key: "d0" },
            "网关使用 Qoder CLI 自己的登录态，与桌面端的登录互不干扰，可同时在线。"));
        }

        rows.push(h("div", { className: "qr-row", key: "act" },
          h(Btn, { onClick: onLogin, disabled: busy },
            loggedIn ? "重新登录" : "登录 Qoder")));

        rows.push(h("p", { className: "qr-muted", key: "hint" },
          loggedIn ? "重新登录会生成新的设备码链接；不重新登录则沿用当前凭证。"
                   : "点击后会生成设备码链接，在浏览器打开完成授权即可。"));

        children.push(h("div", { className: "qr-card", key: "loginbtn" },
          h("h4", { className: "qr-title" }, "登录"), ...rows));
      }

      // 模型
      if (st && st.ok && (st.models || []).length) {
        children.push(h("div", { className: "qr-card", key: "models" },
          h("h4", { className: "qr-title" }, "可用模型"),
          h("div", { className: "qr-models" },
            ...st.models.map((m, i) => h("span", { className: "qr-chip", key: i }, m)))));
      }

      // 版本与更新
      {
        const u = upd.phase === "ready" ? upd.data : null;
        const rows = [];

        if (upd.phase === "idle" || upd.phase === "checking") {
          rows.push(h("div", { className: "qr-row", key: "v0" }, h(Badge, { kind: "wait" }, "检查中…")));
        } else if (upd.phase === "error") {
          rows.push(h("div", { className: "qr-row", key: "v1" }, h(Badge, { kind: "wait" }, "检查失败")));
          rows.push(h("p", { className: "qr-muted", key: "v2" }, upd.message));
        } else if (u) {
          if (u.hasUpdate) {
            rows.push(h("div", { className: "qr-row", key: "v3" },
              h(Badge, { kind: "ok" }, "有新版本"),
              h("span", { className: "qr-muted" }, u.current + " → " + u.latest)));
            if (u.publishedAt) {
              rows.push(h("div", { className: "qr-muted", key: "v4" }, "发布于 " + u.publishedAt));
            }
            rows.push(h("div", { className: "qr-code", key: "v5" }, u.install));
            const busyApply = apply.phase === "running";
            const btns = [
              h(Btn, {
                key: "apply",
                primary: true,
                disabled: busyApply,
                onClick: () => doUpdate("github:ccccqiang/dsh-qoder-relay#v" + u.latest)
              }, busyApply ? "更新中…" : "立即更新到 v" + u.latest),
              h(Btn, { key: "open", onClick: () => window.open(u.url, "_blank", "noreferrer") }, "打开发布页"),
              h(Btn, { key: "notes", onClick: () => setShowNotes(!showNotes) },
                showNotes ? "隐藏更新说明" : "查看更新说明")
            ];
            rows.push(h("div", { className: "qr-row", key: "v6" }, ...btns));
            if (apply.phase === "running") {
              rows.push(h("p", { className: "qr-muted", key: "v6a" },
                "正在通过宿主安装，可能需要十几秒。完成后重启 DSH 生效。"));
            } else if (apply.phase === "done") {
              rows.push(h("div", { className: "qr-row", key: "v6b" },
                h(Badge, { kind: "ok" }, "安装已提交"),
                h("span", { className: "qr-muted" }, apply.spec || "")));
              rows.push(h("p", { className: "qr-muted", key: "v6c" }, "重启 DSH 后生效。"));
            } else if (apply.phase === "error") {
              rows.push(h("div", { className: "qr-row", key: "v6d" },
                h(Badge, { kind: "wait" }, "安装失败")));
              rows.push(h("p", { className: "qr-muted", key: "v6e" }, apply.message));
              rows.push(h("p", { className: "qr-muted", key: "v6f" },
                "若报 pnpm 完整性错误，多半是其他依赖（如 dsh-purge 的 master 分支地址）触发的，与本插件无关。"));
            }
            rows.push(h("p", { className: "qr-muted", key: "v7" },
              "手动方式：把上面那行写进 profile 的 dependencies（替换现有 dsh-qoder-relay 那行），再跑 pnpm install 并重启 DSH。"));
            if (u.via) {
              rows.push(h("div", { className: "qr-muted", key: "v7b" }, "数据来源：" + u.via));
            }
            rows.push(h("pre", { className: "qr-pre", key: "v8", style: showNotes ? {} : { display: "none" } }, u.notes || "(无说明)"));
          } else {
            rows.push(h("div", { className: "qr-row", key: "v9" },
              h(Badge, { kind: "ok" }, "已是最新"),
              h("span", { className: "qr-muted" }, "v" + u.current)));
            if (u.checkedAt) {
              rows.push(h("div", { className: "qr-muted", key: "v10" }, "检查于 " + u.checkedAt));
            }
            rows.push(h("div", { className: "qr-row", key: "v11" },
              h(Btn, { onClick: () => window.open(u.url, "_blank", "noreferrer") }, "打开发布页")));
          }
        }

        rows.push(h("div", { className: "qr-row", key: "v12" },
          h(Btn, { onClick: () => checkUpdate(true), disabled: upd.phase === "checking" }, "检查更新")));

        children.push(h("div", { className: "qr-card", key: "ver" },
          h("h4", { className: "qr-title" }, "版本"), ...rows));
      }

      // 接入
      children.push(h("div", { className: "qr-card", key: "ep" },
        h("h4", { className: "qr-title" }, "接入方式"),
        h("p", { className: "qr-desc" }, "网关是标准 OpenAI 兼容端点，DSH 通过 llm-pi-ai 路由接入。"),
        h("div", { className: "qr-code" }, cfg.baseURL + "/v1")));

      // 排错
      children.push(h("div", { className: "qr-card", key: "help" },
        h("h4", { className: "qr-title" }, "登录不上？"),
        h("ol", { className: "qr-steps" },
          h("li", null, "确认已安装 Qoder CN 桌面端 —— 网关借它的可执行文件当 Node 运行时。"),
          h("li", null, "点「重新检测」看具体原因，它会区分「找不到安装」和「未登录」。"),
          h("li", null, "若浏览器打开链接后无反应，点「查看输出」看 CLI 的原始日志。"))));

      return h("div", { className: "qr-wrap" }, ...children);
    }

    /* ─────────── 入口 ─────────── */
    function apply(ctx) {
      ensureCss();
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
        console.warn("[qoder-relay] ctx.slots 不可用，设置页不会出现");
        return;
      }
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "qoder-relay",
        order: 40,
        label: () => "Qoder CN"
      }, function QoderSection() {
        return h(QoderPanel);
      }));
    }

    exports.apply = apply;
    // client 端的 inject 是**运行时短名**，不是 package.json 里的包全名。
    // 少了这一行，client 加载器不知道该等哪些服务就绪，会判定 boot 失败
    // 且不给出错误信息（"The client Loader did not provide an error message"）。
    // 参照 dsh-session-recycle-bin 的可用形态：它是同类手写包，导出了
    //   exports.inject = ['slots', 'connection', 'sessions', 'workspaces'];
    exports.inject = ['slots', 'connection'];

    return module.exports;
  }
});