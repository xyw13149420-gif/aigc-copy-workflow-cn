/* 站点版前端：云端商品库 + 免密钥大模型 + 云端记录。
 *
 * 页面本身（渲染、合规、分镜、成片）由 page.template.html 里的内联脚本负责，
 * 这里只做数据层：连云服务、选品、生成、入库、记录回看、导出。
 * 页面里没有任何密钥：模型调用走本应用的云服务通道，凭 publishableKey + 域名校验。
 */
(function () {
  'use strict';

  var A = window.__AIGC;
  if (!A || !A.isSite) return;

  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.CLOUD_CONFIG || null;
  var cloud = null;

  /* 一个节点找不到，不该让整页停摆。
     线上出现过一次「新页面 + 旧脚本」：旧脚本按老 DOM 取节点得到 null，
     第一句 addEventListener 就抛错，后面的下拉、生成全没绑上，
     页面上却看不出哪里坏了。绑定时统一走这个口子，缺节点只是跳过。 */
  function on(el, type, fn, opts) {
    if (!el || !el.addEventListener) return null;
    el.addEventListener(type, fn, opts);
    return el;
  }

  /* 真出错也要让人看得见：这页是公开演示，不能只剩一个点不动的按钮 */
  function reportFatal(msg) {
    var box = $('notice');
    if (!box) return;
    var text = String(msg || '未知错误');
    box.hidden = false;
    box.innerHTML = '页面脚本报错：<b>' + text.replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    }) + '</b><br>先刷新一次（一般是浏览器缓存了旧脚本）；还不行就把这句话截图发我。';
  }
  window.addEventListener('error', function (ev) {
    if (!ev || /Script error/i.test(ev.message || '')) return;
    reportFatal(ev.message);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (r && (r instanceof TypeError || r instanceof ReferenceError)) reportFatal(r.message);
  });

  function disableGen() {
    var b = $('btn-ai');
    if (b) b.disabled = true;
  }

  var products = [];
  var current = null;
  var models = null;
  var busy = false;
  var lastId = null;
  var stale = false;
  var lastGenAt = 0;
  var MIN_GAP = 4000; // 生成按钮冷却，避免把通道额度连着打光

  var state = { records: 0 };

  /* ------------------------------------------------------------ 小工具 */
  function notice(html) {
    var el = $('notice');
    if (!el) return;
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = html;
  }

  function setBar(parts, warn) {
    var html = '<span class="dot' + (warn ? ' off' : '') + '"></span>' + parts.join(' ');
    var el = $('apibar');
    if (el) el.innerHTML = html;
  }

  function barIdle() {
    setBar([
      '<b>商品库</b> ' + products.length + ' SKU',
      '<span class="sep">/</span>',
      '<b>生成</b> ' + (models ? models.primary.name : '未连接'),
      '<span class="sep">/</span>',
      '<b>记录</b> ' + state.records + ' 条',
    ], !models);
  }

  function hhmm(iso) {
    var d = new Date(iso);
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function errText(e) {
    var code = (e && (e.code || (e.error && e.error.code))) || '';
    if (/^auth_/.test(code)) {
      return '云服务拒绝了这次请求（来源校验或凭据无效）。请从发布域名打开本页，本地文件或 localhost 下无法调用云端模型。';
    }
    if (/^quota_/.test(code)) return '云端模型额度不足或触发限流，过一会儿再试。';
    if (/^gateway_|^model_/.test(code)) return '模型服务临时不可用，再点一次「生成文案」试试。';
    if (/^request_/.test(code)) return '请求与模型参数不匹配：' + (e.message || code);
    if (/^internal_/.test(code)) {
      return '服务内部错误' + (e.requestId ? '（requestId ' + e.requestId + '）' : '') + '，稍后重试。';
    }
    return (e && e.message) || '未知错误';
  }

  /* ------------------------------------------------------------ 云服务 */
  function initCloud() {
    if (!window.WorkBuddyCloud) {
      throw Object.assign(new Error('云服务 SDK 没加载出来（CDN 被拦或断网）。'), { code: 'sdk_missing' });
    }
    if (!cfg || !cfg.endpoint || !cfg.publishableKey) {
      throw Object.assign(new Error('页面缺少云服务配置。'), { code: 'config_missing' });
    }
    cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
      publishableKey: cfg.publishableKey,
    });
  }

  async function loadProducts() {
    var res = await cloud.database.from('products').select('*').order('sort', { ascending: true });
    if (res.error) throw res.error;
    return res.data || [];
  }

  /* 模型候选链。
   * 目录是运行时拉取的（不写死单一模型 id）；这里只表达偏好：写中文结构化 JSON 要快、
   * 不要思考段。实测 default / auto 这类带思考的路由首字要 10s 上下，还会把
   * </think> 标记漏进正文，所以排在后面，且逐个失败自动往后换。
   */
  var PREFERRED = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hunyuan-chat'];

  async function loadModels() {
    var models = await cloud.llm.models.list();
    if (!models || !models.length) {
      throw Object.assign(new Error('当前应用没有可用的模型。'), { code: 'no_model' });
    }
    var usable = models.filter(function (m) { return m.disabled !== true && m.enabled !== false; });
    if (!usable.length) {
      throw Object.assign(new Error('模型目录里的模型都被禁用了。'), { code: 'no_model' });
    }

    var chain = [];
    var push = function (m) {
      if (!m) return;
      for (var i = 0; i < chain.length; i++) { if (chain[i].id === m.id) return; }
      chain.push(m);
    };

    PREFERRED.forEach(function (id) {
      for (var i = 0; i < usable.length; i++) { if (usable[i].id === id) { push(usable[i]); return; } }
    });
    // 兜底：先非思考模型（结构化输出更稳），再目录默认，最后任意可用
    usable.filter(function (m) { return m.onlyReasoning !== true; }).forEach(push);
    usable.filter(function (m) { return m.isDefault === true; }).forEach(push);

    return {
      primary: chain[0],
      chain: chain.slice(0, 3),
    };
  }

  /* -------------------------------------------------------------- 选品 */
  var listEl = $('prod-list');
  var comboEl = $('prod-combo');
  var actIdx = -1;              // 键盘高亮到第几项

  function comboOpen() {
    if (!comboEl) return;
    // 打开时列全部：输入框里已有的名字只用于高亮，不该把列表筛成一条
    paintList('');
    comboEl.classList.add('open');
    $('f-product').setAttribute('aria-expanded', 'true');
  }
  function comboClose() {
    if (!comboEl) return;
    comboEl.classList.remove('open');
    $('f-product').setAttribute('aria-expanded', 'false');
    actIdx = -1;
  }

  function matchProducts(q) {
    var k = String(q || '').trim().toLowerCase();
    if (!k) return products;
    return products.filter(function (p) {
      return (p.name + ' ' + (p.spec || '') + ' ' + (p.category || '') + ' ' + (p.audience || ''))
        .toLowerCase().indexOf(k) >= 0;
    });
  }

  function paintList(q) {
    if (!listEl) return;
    var typed = String(q || '').trim();
    var rows = matchProducts(typed);
    var html = rows.map(function (p) {
      var f = window.__POST.facetsOf(p, TEMPLATES);
      var on = current && current.id === p.id;
      return '<div class="citem' + (on ? ' on' : '') + '" role="option" data-id="' + p.id + '"' +
        (on ? ' aria-selected="true"' : '') + '>' +
        '<span class="cn">' + escHtml(p.name) + '</span>' +
        '<span class="cs">' + escHtml(p.spec || '') + '</span>' +
        '<span class="ck">' + escHtml(f ? f.kindWord : '') + '</span></div>';
    }).join('');

    // 输入的名字不在库里时，列表末尾给一条明确的出路，而不是只弹一句「没有这个商品」
    var exact = rows.some(function (p) { return String(p.name).trim() === typed; });
    if (typed && !exact) {
      html += '<div class="citem citem-new" role="option" data-id="">' +
        '<span class="cn">直接用「' + escHtml(typed) + '」</span>' +
        '<span class="ck">手输</span></div>';
    }
    if (!html) html = '<div class="cempty">商品库暂时没有可选项，<b>直接在上面写商品名</b>即可。</div>';

    listEl.innerHTML = html;
    actIdx = -1;
  }

  function fillProducts() {
    if (products.length) selectProduct(products[0].id);
    paintList('');
  }

  function selectProduct(id) {
    var found = null;
    for (var i = 0; i < products.length; i++) { if (products[i].id === id) { found = products[i]; break; } }
    current = found || products[0];
    if (!current) return;

    $('f-product').value = current.name;
    $('f-price').value = current.price;
    $('f-spec').value = current.spec || '';
    $('f-audience').value = current.audience || '';

    var a = current.attributes || {};
    var f = window.__POST.facetsOf(current, TEMPLATES);
    $('prod-meta').innerHTML = [
      '<div><b>' + current.id + '</b> · ¥' + current.price + ' · ' + current.spec + '</div>',
      '<div>' + (a.ingredients || []).slice(0, 2).join(' / ') +
        '<span class="sep">｜</span>' + (a.functions || []).join(' / ') + '</div>',
      '<div>' + (f ? f.kindWord + ' · ' + f.speciesWord + ' · 按「' + f.unit + '」计量' : '') +
        '<span class="sep">｜</span>库存 ' + current.stock + ' · ' + current.warehouse + '</div>',
    ].join('');

    comboClose();
    if (A.fitNum) A.fitNum();
    renderLocal();
  }

  /* 手输的商品名与下拉选中的不是同一个时，以手输为准：
     合成一条临时商品记录，口播、分镜、两套提示词全跟着它走，不能只有标题换了名字。 */
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function typedMode() {
    if (!current) return false;
    var v = ($('f-product').value || '').trim();
    return !!v && v !== String(current.name || '').trim();
  }

  function effective() {
    var p = A.params();
    if (typedMode() && window.__FACETS && window.__FACETS.fromParams) {
      var f = window.__FACETS.fromParams(p, TEMPLATES);
      if (f && f.product) return { params: p, facets: f, product: f.product, typed: true };
    }
    return { params: p, facets: window.__POST.facetsOf(current, TEMPLATES), product: current, typed: false };
  }

  /* 本地模板预览：不花额度，改参数即时反馈 */
  function renderLocal() {
    if (!current) return;
    var e = effective();
    var p = e.params;
    var base = window.__POST.baseline(TEMPLATES, e.product, p, e.facets);
    base.meta = Object.assign({}, base.meta, {
      platform: p.platform, count: p.count, price: p.price,
      product: p.product, source: 'template', model: '', latency_ms: 0, tokens: 0,
    });
    A.render(base);
    stale = true;
    updateExport();
    if (e.typed) {
      var f = e.facets;
      $('prod-meta').innerHTML = [
        '<div><b>手输商品</b> · ' + escHtml(p.product) + '</div>',
        '<div>' + ((f.pools && f.pools.ingredient) || []).slice(0, 2).join(' / ') + '<span class="sep">｜</span>' +
          (f.kindWord || '') + ' · ' + (f.speciesWord || '') + ' · 按「' + (f.unit || '件') + '」计量</div>',
        '<div>口播与提示词都按这个名字重算<span class="sep">｜</span>下拉选回商品即可还原</div>',
      ].join('');
      setBar(['<b>手输商品</b> ' + p.product, '<span class="sep">/</span>', '点「生成文案」走云端模型'], true);
    } else {
      setBar(['<b>本地模板预览</b> ' + current.name, '<span class="sep">/</span>', '点「生成文案」走云端模型'], true);
    }
  }

  /* -------------------------------------------------------------- 生成 */
  async function runOnce(m, prompt) {
    var t0 = performance.now();
    var text = '';
    var usage = null;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 45000);
    var charsAt = 0;

    try {
      var stream = cloud.llm.chat.completions.create({
        model: m.id,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        stream: true,
        stream_options: { include_usage: true },
        signal: controller.signal,
      });

      for await (var chunk of stream) {
        var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) {
          text += d.content;
          var now = performance.now();
          if (now - charsAt > 300) {
            charsAt = now;
            setBar(['<b>生成中</b> ' + current.name, '<span class="sep">/</span>',
              m.name, '<span class="sep">/</span>', '已收到 ' + text.length + ' 字'], false);
          }
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } finally {
      clearTimeout(timer);
    }

    if (!text.trim()) {
      throw Object.assign(new Error('模型没有返回内容'), { code: 'gateway_empty' });
    }
    return { text: text, usage: usage, latency: Math.round(performance.now() - t0) };
  }

  async function generate() {
    if (busy || !current) return;
    if (!models || !models.chain.length) { notice('云端模型还没就绪，稍后再试或刷新页面。'); return; }

    var gap = Date.now() - lastGenAt;
    if (gap < MIN_GAP) {
      notice('刚生成过，<b>' + Math.ceil((MIN_GAP - gap) / 1000) + ' 秒</b>后再来一次 —— 这个页面是公开演示，通道额度有限。');
      return;
    }

    busy = true;
    lastGenAt = Date.now();
    var btn = $('btn-ai');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    notice('');

    var eff = effective();
    var params = eff.params;
    var rules = ((TEMPLATES.sections.compliance.platform_rules || {})[params.platform]) || {};
    // 品类/物种适配层只算一次：提示词与模板基线用同一份，避免模型和兜底各说各的品类
    var facets = eff.facets;
    var prompt = window.__POST.buildPrompt(eff.product, params, rules, facets);
    var base = window.__POST.baseline(TEMPLATES, eff.product, params, facets);

    var lastErr = null;
    try {
      for (var i = 0; i < models.chain.length; i++) {
        var m = models.chain[i];
        setBar(['<b>生成中</b> ' + current.name, '<span class="sep">/</span>', m.name], false);
        try {
          var out = await runOnce(m, prompt);

          var parsed;
          try {
            parsed = JSON.parse(window.__POST.extractJson(out.text));
          } catch (e) {
            throw Object.assign(new Error('模型输出不是合法 JSON'), {
              code: 'llm_bad_payload', raw: out.text.slice(0, 4000),
            });
          }

          var result = window.__POST.assemble(parsed, base, params, TEMPLATES);
          result.meta = {
            seed: params.seed, platform: params.platform, count: params.count,
            price: params.price, product: params.product,
            source: 'llm', model: m.name + ' / ' + m.id,
            latency_ms: out.latency, tokens: (out.usage && out.usage.total_tokens) || 0,
          };

          A.render(result);
          stale = false;
          updateExport();

          setBar([
            '<b>' + m.name + '</b>',
            (out.latency / 1000).toFixed(1) + 's',
            ((out.usage && out.usage.total_tokens) || 0) + ' tokens',
            '<span class="sep">/</span>',
            result.compliance.total ? '合规命中 ' + result.compliance.total + ' 处，已替换' : '合规 0 命中',
          ], false);

          await saveRecord(result, params);
          return;
        } catch (e) {
          lastErr = e;
          console.warn('[生成] ' + m.id + ' 失败：' + (e.code || e.message));
          if (e.code === 'llm_bad_payload' && e.raw) {
            console.warn('[生成] 原始输出前 800 字：\n' + e.raw.slice(0, 800));
          }
          if (i < models.chain.length - 1) {
            notice('「' + A.esc(m.name) + '」这次没跑通，正在换下一个模型…');
          }
        }
      }
      barIdle();
      notice('生成失败：' + A.esc(errText(lastErr)) + '（已试过 ' + models.chain.length + ' 个模型）');
      console.error('[生成]', lastErr);
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    }
  }

  async function saveRecord(result, params) {
    try {
      var res = await cloud.database.from('generations').insert({
        product_id: current.id,
        product_name: current.name,
        platform: params.platform,
        mode: 'llm',
        model: result.meta.model,
        latency_ms: result.meta.latency_ms,
        tokens: result.meta.tokens,
        params: {
          price: params.price, spec: params.spec, audience: params.audience,
          count: params.count, seed: params.seed,
        },
        result: result,
      }).select('id').single();

      if (res.error) throw res.error;
      lastId = res.data ? res.data.id : null;
      updateExport();
      if (lastId) {
        setBar(['<b>' + result.meta.model.split(' / ')[0] + '</b>',
          (result.meta.latency_ms / 1000).toFixed(1) + 's',
          result.meta.tokens + ' tokens',
          '<span class="sep">/</span>',
          '已存入记录 <b>#' + lastId + '</b>'], false);
      }
      refreshHistory();
    } catch (e) {
      // 结果已经渲染出来了，写库失败不该把这次生成一起丢掉
      notice('文案已生成，但写记录失败：' + A.esc(errText(e)));
      console.error('[写入记录]', e);
    }
  }

  /* -------------------------------------------------------------- 记录 */
  async function refreshHistory() {
    var host = $('out-history');
    var res;
    try {
      res = await cloud.database
        .from('generations')
        .select('id,product_name,platform,mode,model,latency_ms,tokens,created_at')
        .order('created_at', { ascending: false })
        .limit(20);
    } catch (e) {
      host.innerHTML = '<div class="hrow"><span class="hid">—</span><span class="hp">记录读取失败：' +
        A.esc(errText(e)) + '</span></div>';
      return;
    }
    if (res.error) {
      host.innerHTML = '<div class="hrow"><span class="hid">—</span><span class="hp">记录读取失败：' +
        A.esc(errText(res.error)) + '</span></div>';
      return;
    }

    var items = res.data || [];
    state.records = items.length;
    if (!items.length) {
      host.innerHTML = '<div class="hrow"><span class="hid">—</span><span class="hp">还没有记录，点一次「生成文案」</span></div>';
      $('meta-history').textContent = '最近 20 条 · 存于云端';
      barIdle();
      return;
    }

    host.innerHTML = items.map(function (g) {
      return '<div class="hrow' + (g.id === lastId ? ' cur' : '') + '" data-id="' + g.id + '"' +
        ' data-name="' + A.esc(g.product_name) + '">' +
        '<span class="hid">#' + g.id + '</span>' +
        '<span class="hp" title="' + A.esc(g.product_name) + '">' + A.esc(g.product_name) +
          ' · ' + A.esc(g.platform) + '<em>' + hhmm(g.created_at) + '</em></span>' +
        '<span class="hx" title="' + A.esc(g.model || '') + '">' +
          (g.mode === 'llm' ? 'AI' : '模板') + ' · ' + ((g.latency_ms || 0) / 1000).toFixed(1) + 's · ' +
          (g.tokens || 0) + 'tok</span>' +
        '<span class="acts">' +
          '<button type="button" data-act="load">载入</button>' +
          '<button type="button" class="mdbtn" data-act="md">md</button>' +
          '<button type="button" class="mdbtn" data-act="csv">csv</button>' +
          '<button type="button" class="del" data-act="del" title="删除这条记录" aria-label="删除记录 #' + g.id + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M4 6.6h16M9.6 6.6V5.2a1.6 1.6 0 0 1 1.6-1.6h1.6a1.6 1.6 0 0 1 1.6 1.6v1.4M17.4 6.6l-.7 12.2a2 2 0 0 1-2 1.9h-5.4a2 2 0 0 1-2-1.9L6.6 6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>' +
          '</button>' +
        '</span>' +
      '</div>';
    }).join('');

    $('meta-history').textContent = '最近 ' + items.length + ' 条 · 公开可见 · 存于云端';
    barIdle();
  }

  async function fetchRecord(id) {
    var res = await cloud.database.from('generations').select('*').eq('id', id).single();
    if (res.error) throw res.error;
    return res.data;
  }

  async function loadRecord(id) {
    try {
      var rec = await fetchRecord(id);
      if (rec.product_id && products.some(function (p) { return p.id === rec.product_id; })) {
        selectProduct(rec.product_id);
      }
      var prm = rec.params || {};
      if (prm.platform) $('f-platform').value = prm.platform;
      if (prm.price) $('f-price').value = prm.price;
      if (prm.count) $('f-count').value = String(prm.count);
      // 程序写进去的值不会触发 change：下拉按钮上的字和输入框宽度得手动对齐
      if (A.syncSelects) A.syncSelects();
      if (A.fitNum) A.fitNum();

      A.render(rec.result);
      lastId = rec.id;
      stale = false;
      updateExport();
      await refreshHistory();  // 先刷列表（它会重置状态条），再把"已载入"写上去
      setBar(['已载入记录 <b>#' + rec.id + '</b>',
        '<span class="sep">/</span>' + hhmm(rec.created_at),
        '<span class="sep">/</span>' + A.esc(rec.model || '模板')], false);
    } catch (e) {
      notice('载入失败：' + errText(e));
    }
  }

  /* 删除一条记录：先压暗弹确认，确认之后才真的动云端 */
  async function removeRecord(id) {
    try {
      var res = await cloud.database.from('generations').delete().eq('id', id);
      if (res && res.error) throw res.error;
      // 后端在「没有 DELETE 策略」时往往不报错，只是删了 0 行。
      // 所以不能凭返回码宣布成功，必须回查一次。
      var check = await cloud.database.from('generations').select('id').eq('id', id);
      if (check && check.error) throw check.error;
      if (((check && check.data) || []).length) {
        notice('删除没有生效：这条记录还在云端。数据库目前只开放了「新增 / 读取」权限，' +
          '缺一条 DELETE 策略，加上之后删除才会真的执行。');
        return;
      }
      if (lastId === id) { lastId = null; updateExport(); }
      await refreshHistory();
      setBar(['已删除记录 <b>#' + id + '</b>', '<span class="sep">/</span>', '云端已同步'], true);
    } catch (e) {
      notice('删除失败：' + A.esc(errText(e)) + ' 记录还在，可以稍后再试。');
    }
  }

  async function exportRecord(id, fmt) {
    try {
      var rec = await fetchRecord(id);
      var prm = rec.params || {};
      if (fmt === 'csv') {
        download('aigc-' + id + '.csv', '\ufeff' + A.csvOf(rec.result), 'text/csv');
      } else {
        download('aigc-' + id + '.md', A.markdownOf(rec.result, prm), 'text/markdown');
      }
    } catch (e) {
      notice('导出失败：' + errText(e));
    }
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function updateExport() {
    var on = Boolean(lastId) && !stale;
    ['btn-export-md', 'btn-export-csv'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.disabled = !on;
      b.title = on ? '' : '先生成一次，导出的才是云端那条记录';
    });
  }

  /* -------------------------------------------------------------- 启动 */
  async function boot() {
    setBar(['<b>连接云端</b> 商品库 / 模型 / 记录…'], false);

    try {
      initCloud();
    } catch (e) {
      setBar(['云端未连接'], true);
      notice('云服务没连上：' + A.esc(e.message) + ' 页面仍可用本地模板预览。');
      disableGen();
      return;
    }

    try {
      products = await loadProducts();
    } catch (e) {
      products = [];
      console.error('[商品库]', e);
    }
    if (!products.length) {
      setBar(['商品库为空'], true);
      notice('云端商品库读不到数据（' + A.esc(errText(new Error('空结果'))) + '）。记录与生成仍然可用，但选品不可用。');
      disableGen();
      return;
    }

    try {
      models = await loadModels();
    } catch (e) {
      models = null;
      console.error('[模型目录]', e);
      notice('没拿到可用模型：' + A.esc(errText(e)) + ' 现在只能看本地模板预览。');
      disableGen();
    }

    fillProducts();
    barIdle();
    if (models && $('btn-ai')) $('btn-ai').title = '调 ' + models.primary.name + ' 生成，结果存进云端记录';
    refreshHistory();
  }

  /* 商品：下拉可选，也能直接写；手输的名字会和商品库一样出口播与两套提示词 */
  if (listEl) {
    // 列表里两种项：商品库里的（有 id）和「直接用你写的名字」（无 id）
    function useItem(it) {
      if (!it) return;
      if (it.dataset.id) selectProduct(it.dataset.id);
      else { comboClose(); renderLocal(); }
    }
    on($('prod-toggle'), 'click', function (e) {
      e.preventDefault();
      if (comboEl.classList.contains('open')) comboClose();
      else { comboOpen(); $('f-product').focus(); }
    });
    // 点输入框只是把光标放进去，不再顺手弹一屏列表：
    // 想挑就让右边箭头展开，想搜就直接打字（打字才筛）。
    on($('f-product'), 'keydown', function (e) {
      var items = listEl.querySelectorAll('.citem');
      if (e.key === 'Escape') { comboClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!comboEl.classList.contains('open')) {
          // 键盘进来是先开列表、顺手就落在第一项上，不用再按一次
          comboOpen();
          var fresh = listEl.querySelectorAll('.citem');
          if (!fresh.length) return;
          actIdx = e.key === 'ArrowDown' ? 0 : fresh.length - 1;
          Array.prototype.forEach.call(fresh, function (el, i) {
            el.classList.toggle('act', i === actIdx);
          });
          fresh[actIdx].scrollIntoView({ block: 'nearest' });
          return;
        }
        var items = listEl.querySelectorAll('.citem');
        if (!items.length) return;
        actIdx = e.key === 'ArrowDown'
          ? (actIdx + 1) % items.length
          : (actIdx - 1 + items.length) % items.length;
        Array.prototype.forEach.call(items, function (el, i) {
          el.classList.toggle('act', i === actIdx);
        });
        items[actIdx].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        if (actIdx >= 0 && items[actIdx]) { e.preventDefault(); useItem(items[actIdx]); }
        else { comboClose(); renderLocal(); }
      }
    });
    // mousedown 先于 blur：避免点选项时列表先收起、点击落空
    on(listEl, 'mousedown', function (e) {
      var it = e.target.closest('.citem');
      if (!it) return;
      e.preventDefault();
      useItem(it);
    });
    document.addEventListener('click', function (e) {
      if (!comboEl.contains(e.target)) comboClose();
    });
  }

  // 手输商品名：停顿一下就重算，不用等点生成 —— 手输的商品也要有自己的口播和提示词
  var typedTimer = null;
  on($('f-product'), 'input', function () {
    if (listEl) {
      paintList(this.value);
      comboEl.classList.add('open');
      $('f-product').setAttribute('aria-expanded', 'true');
    }
    clearTimeout(typedTimer);
    typedTimer = setTimeout(function () { if (current) renderLocal(); }, 320);
  });
  on($('btn-ai'), 'click', generate);
  ['f-price', 'f-count', 'f-platform'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    on(el, 'input', renderLocal);
    on(el, 'change', renderLocal);
  });
  on($('btn-export-md'), 'click', function () {
    if (lastId) exportRecord(lastId, 'md');
  });
  on($('btn-export-csv'), 'click', function () {
    if (lastId) exportRecord(lastId, 'csv');
  });
  on($('out-history'), 'click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var row = btn.closest('.hrow');
    var id = Number(row && row.dataset.id);
    if (!id) return;                       // 「正在读取…」那几行没有 id
    var act = btn.dataset.act;
    if (act === 'load') { loadRecord(id); return; }
    if (act === 'del') {
      var who = row.dataset.name || '';
      A.confirm({
        title: '删除这条记录？',
        desc: '记录 <b>#' + id + '</b>' + (who ? '「' + A.esc(who) + '」' : '') +
          ' 将从云端移除，删除后无法恢复，也导不回来了。',
        okText: '删除',
      }).then(function (ok) { if (ok) removeRecord(id); });
      return;
    }
    exportRecord(id, act);
  });

  boot().catch(function (e) {
    reportFatal('启动失败：' + (e && e.message ? e.message : e));
  });
})();
