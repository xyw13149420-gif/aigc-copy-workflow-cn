/* 模型输出 → 页面结构的后置校验（浏览器端）
 *
 * 分工没变，只是从服务端搬到了浏览器：
 *   商品事实  —— 来自云端商品库，模型不许编
 *   文案表达  —— 云端大模型生成
 *   结构与红线 —— 这里兜底：30 字截断、80 字话术、Jaccard 去重、条数补齐、极限词替换
 * 模型输出视为不可信文本：只解析、不执行；渲染前统一转义。
 */
(function (root) {
  'use strict';

  var MAX_TITLE = 30;
  var MAX_CS = 80;
  var CHARS = ['售前', '物流', '售后', '催付'];
  var SEGS = [
    { range: '0-3s', stage: '钩子' },
    { range: '3-15s', stage: '卖点证明' },
    { range: '15-25s', stage: '促单' }
  ];

  function norm(t) {
    return String(t).replace(/[^0-9a-zA-Z\u4e00-\u9fff%]/g, '').toLowerCase();
  }

  function bigrams(t) {
    var s = {};
    for (var i = 0; i < t.length - 1; i++) s[t.slice(i, i + 2)] = 1;
    return Object.keys(s);
  }

  function tooSimilar(a, b, th) {
    if (a === b) return true;
    var ga = bigrams(a), gb = bigrams(b);
    if (!ga.length || !gb.length) return false;
    var set = {}; gb.forEach(function (g) { set[g] = 1; });
    var inter = 0;
    ga.forEach(function (g) { if (set[g]) inter++; });
    return inter / (ga.length + gb.length - inter) >= (th || 0.8);
  }

  /* 商品记录 → 引擎参数 */
  function paramsFromProduct(product, overrides) {
    var o = overrides || {};
    return {
      product: product.name,
      price: o.price !== undefined && o.price !== '' ? Number(o.price) : Number(product.price),
      spec: o.spec || product.spec || '',
      audience: o.audience || product.audience || '',
      platform: o.platform || 'tmall',
      count: Number(o.count) || 5,
      seed: o.seed === undefined ? 7 : Number(o.seed)
    };
  }

  /* 商品 → 品类/物种适配层（词池、量词、形态、卖点都从这里来） */
  function facetsOf(product, templates) {
    if (!root.__FACETS) return null;
    return root.__FACETS.derive(product, templates || null);
  }

  /* 本地模板基线：模型哪一段缺失，就用它补，且标记 fallback
   * 词池、量词形态、六条卖点全部来自商品本身，不掺猫粮词库
   */
  function baseline(templates, product, params, facets) {
    var f = facets || facetsOf(product, templates);
    if (!f) {
      var base0 = root.AIGCEngine.generate(templates, params);
      base0.ctx.product = params.product;
      return base0;
    }
    var opts = Object.assign({}, params, {
      audienceShort: f.pools.audience[0],
      overrides: { pools: f.pools, lexicon: f.lexicon, selling: f.selling }
    });
    var base = root.AIGCEngine.generate(templates, opts);
    base.ctx.product = params.product;
    base.ctx.price = String(params.price);
    base.ctx.spec = params.spec;
    base.ctx.audience = params.audience;
    base.ctx['品类'] = f.kindWord;
    if (!base.ctx['赠品']) base.ctx['赠品'] = '无'; // chips 上直接显示「无」，别留个空格子
    if (!base.ctx['核心成分']) base.ctx['核心成分'] = (f.facts.ingredients || [])[0] || '—';
    if (!base.ctx['场景']) base.ctx['场景'] = '—';
    if (!base.ctx['数字卖点']) base.ctx['数字卖点'] = '待补实测值';
    return base;
  }

  /* 参数面板直连（离线单文件版）：没有商品库，就从面板文字里认出品类与物种，
     再走同一条基线。识别不出来（模板库缺 demo_pools）才退回原引擎 */
  function baselinePanel(templates, params) {
    var f = (root.__FACETS && root.__FACETS.fromParams) ? root.__FACETS.fromParams(params, templates) : null;
    return { result: baseline(templates, null, params, f), facets: f };
  }

  /* ------------------------------------------------------------- 提示词 */
  /* 不同品类能说的事完全不同：猫砂不能说适口性和换粮，零食不能说正餐营养 */
  var KIND_HINT = {
    dry: '主粮品类：只谈配方、营养数值、适口、便便与换粮过渡。',
    wet: '湿粮/罐头品类：可谈含水量、肉块与汤汁、拌粮与补水，不要写「泡开」「换粮过渡表」。',
    litter: '猫砂品类：只谈粉尘、结团、除臭、带出与清理方式；不要写适口性、换粮、营养吸收、便便成型。',
    treat: '零食品类：只谈配料单一、适口、训练奖励与喂食量；不要写「当主食吃」「换粮」。',
    other: '按商品实际品类写，不要套用主粮话术。'
  };

  function buildPrompt(product, params, rules, facets) {
    var f = facets || facetsOf(product, null);
    var facts = f ? f.facts : {};
    var payload = {
      商品名: product.name,
      品牌: product.brand,
      类目: product.category,
      品类形态: facts.kindWord || product.category,
      目标物种: facts.speciesWord || '宠物',
      规格: params.spec || product.spec,
      到手价: params.price + ' 元',
      目标人群: (facts.audience || [params.audience]).join(' / '),
      配料: facts.ingredients || [],
      主打功能: facts.functions || [],
      使用场景: (facts.scene || []).join(' / '),
      可引用的客观依据: facts.proof || '',
      可引用的真实数值: facts.numbers || [],
      赠品: facts.gift || '无'
    };

    var system = [
      '你是中国' + (product.category || '宠物') + '类目的资深电商文案编辑，为天猫/京东详情页写文案。',
      '本次只写一件商品：' + product.name + '，面向' + (facts.speciesWord || '宠物') + '。',
      KIND_HINT[facts.kind] || KIND_HINT.other,
      '不得写到其它物种或其它品类；不得把本品类没有的属性安上去。',
      '只输出一个 JSON 对象，不要输出任何解释、Markdown 或代码块标记。',
      '硬性约束：',
      '1) 每条标题不超过 30 个字符（含标点与空格）；',
      '2) 每条客服话术不超过 80 个字符；',
      '3) 禁止使用极限词与绝对化表述：最、第一、极品、顶级、国家级、独家、万能、100%、绝对、根治、永久；',
      '4) 不得编造检测报告、销量、好评数、认证、奖项、医疗功效；',
      '5) 只能使用用户给出的商品事实，不得新增配料或营养数值。'
    ].join('\n');

    var user = [
      '商品事实（JSON）：',
      JSON.stringify(payload, null, 2),
      '',
      '发布平台：' + params.platform + '；平台额外注意事项：' + ((rules.focus || []).join('；') || '无'),
      '',
      '请输出 JSON，结构如下（字段名不得改动）：',
      '{',
      '  "titles": ["' + params.count + ' 条商品标题，各自角度不同，不要互相重复"],',
      '  "selling_points": [',
      '    { "category": "用一项主打功能命名，如 ' + ((facts.functions || ['功能'])[0]) + '",',
      '      "text": "一句完整卖点，30-60 字",',
      '      "parts": { "痛点": "用户的具体困扰", "证据": "来自商品事实的客观依据",',
      '                 "结果": "用户能感知到的变化", "数字": "可用的事实数字或规格" } }',
      '  ],',
      '  "cs_scripts": [',
      '    { "scene": "售前", "text": "≤80 字" },',
      '    { "scene": "物流", "text": "≤80 字" },',
      '    { "scene": "售后", "text": "≤80 字" },',
      '    { "scene": "催付", "text": "≤80 字" }',
      '  ],',
      '  "video": { "segments": [',
      '    { "stage": "钩子", "line": "0-3 秒口播，一句话钩住", "subtitle": "花字，6-12 字", "visual": ["镜头提示", "镜头提示"] },',
      '    { "stage": "卖点证明", "line": "3-15 秒口播", "subtitle": "花字", "visual": ["镜头提示"] },',
      '    { "stage": "促单", "line": "15-25 秒口播（赠品为「无」时不要提赠品）", "subtitle": "花字", "visual": ["镜头提示"] }',
      '  ] }',
      '}',
      '',
      '要求：6 条 selling_points，每条对应一项主打功能；口播要像人说话，不要念参数表。'
    ].join('\n');

    return { system: system, user: user };
  }

  /* --------------------------------------------------- 模型结果 → 结构 */
  function coerceTitles(raw, base, count) {
    var list = Array.isArray(raw) ? raw : [];
    var out = [];
    var keys = [];
    for (var i = 0; i < list.length; i++) {
      var text = String(list[i] || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > MAX_TITLE) text = text.slice(0, MAX_TITLE);
      var key = norm(text);
      if (!key || keys.some(function (k) { return tooSimilar(key, k); })) continue;
      out.push({ text: text, template: 'llm', tier: '', band: 'all', chars: text.length, fallback: false });
      keys.push(key);
      if (out.length >= count) break;
    }
    // 不够就用模板补，宁可少一条也不要空着
    for (var j = 0; j < base.titles.length; j++) {
      if (out.length >= count) break;
      var t = base.titles[j];
      var k2 = norm(t.text);
      if (keys.some(function (k) { return tooSimilar(k2, k); })) continue;
      out.push(Object.assign({}, t, { fallback: true, template: t.template || 'fallback' }));
      keys.push(k2);
    }
    return out;
  }

  function coerceSellingPoints(raw, base) {
    var list = Array.isArray(raw) ? raw : [];
    var out = [];
    var keys = [];
    var pains = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.text) continue;
      var parts = item.parts || {};
      var text = String(item.text).trim();
      var key = norm(text);
      var pain = String(parts['痛点'] || parts.pain || '').trim();
      // 模型可能把同一条卖点换个说法写两遍，跟已收下的太像就丢掉
      if (keys.some(function (k) { return tooSimilar(key, k, 0.62); })) continue;
      // 同一个痛点换个句式也算重复：卡片会看起来像凑数
      if (pain && pains.some(function (k) { return tooSimilar(norm(pain), k, 0.7); })) continue;
      if (pain) pains.push(norm(pain));
      out.push({
        id: 'L' + (out.length + 1),
        category: String(item.category || '').slice(0, 8),
        text: text,
        parts: {
          '痛点': pain,
          '证据': String(parts['证据'] || parts.evidence || '').trim(),
          '结果': String(parts['结果'] || parts.result || '').trim(),
          '数字': String(parts['数字'] || parts.number || '').trim()
        }
      });
      keys.push(key);
      if (out.length >= 6) break;
    }
    for (var j = 0; j < base.sellingPoints.length; j++) {
      if (out.length >= 6) break;
      var b = base.sellingPoints[j];
      var k2 = norm(b.text);
      var p2 = (b.parts && b.parts['痛点']) ? norm(b.parts['痛点']) : '';
      if (keys.some(function (k) { return tooSimilar(k2, k, 0.62); })) continue;
      // 模板补位的这条如果和模型已写的痛点撞了，就跳过，换下一条
      if (p2 && pains.some(function (k) { return tooSimilar(p2, k, 0.7); })) continue;
      out.push(Object.assign({}, b));
      keys.push(k2);
      if (p2) pains.push(p2);
    }
    return out;
  }

  function coerceCs(raw, base) {
    var list = Array.isArray(raw) ? raw : [];
    var out = [];
    CHARS.forEach(function (scene) {
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].scene === scene && list[i].text) { hit = list[i]; break; }
      }
      var text = hit ? String(hit.text).replace(/\s+/g, ' ').trim() : '';
      if (text.length > MAX_CS) text = text.slice(0, MAX_CS);
      if (!text) {
        var b = null;
        for (var j = 0; j < base.csScripts.length; j++) {
          if (base.csScripts[j].scene === scene) { b = base.csScripts[j]; break; }
        }
        if (b) { out.push(Object.assign({}, b, { fallback: true })); return; }
      }
      out.push({ id: 'A' + scene, scene: scene, text: text, chars: text.length, limit: MAX_CS, over: text.length > MAX_CS });
    });
    return out;
  }

  function coerceVideo(raw, base) {
    var segs = (raw && Array.isArray(raw.segments)) ? raw.segments : [];
    var out = SEGS.map(function (def, i) {
      var s = segs[i] || {};
      var b = (base.video.segments[i]) || { line: '', subtitle: '', visual: [] };
      var line = String(s.line || b.line || '').trim();
      var subtitle = String(s.subtitle || b.subtitle || '').trim();
      var visual = Array.isArray(s.visual) && s.visual.length
        ? s.visual.map(String).slice(0, 3)
        : (b.visual || []).slice(0, 3);
      return { range: def.range, stage: s.stage || def.stage, line: line, subtitle: subtitle, visual: visual };
    });
    return { id: base.video.id, total: 25, ratio: '9:16', segments: out };
  }

  /* 对最终文案重新扫一遍合规，而不是沿用模板那批的命中数 */
  function summarizeCompliance(result, comp) {
    var detail = {};
    var allowSeen = {};
    var total = 0;

    function countAllow(text) {
      comp.allow.forEach(function (w) {
        var i = text.indexOf(w), c = 0;
        while (i >= 0) { c++; i = text.indexOf(w, i + w.length); }
        if (c) allowSeen[w] = (allowSeen[w] || 0) + c;
      });
    }
    function scan(item) {
      countAllow(item.text);
      var res = root.AIGCEngine.applyCompliance(item.text, comp.terms, comp.mapping, comp.allow);
      item.text = res.text;
      if ('chars' in item) item.chars = item.text.length;
      Object.keys(res.hits).forEach(function (k) {
        detail[k] = (detail[k] || 0) + res.hits[k];
        total += res.hits[k];
      });
    }

    result.titles.forEach(scan);
    result.sellingPoints.forEach(scan);
    result.csScripts.forEach(scan);
    result.video.segments.forEach(function (seg) {
      countAllow(seg.line + ' ' + seg.subtitle);
      var r1 = root.AIGCEngine.applyCompliance(seg.line, comp.terms, comp.mapping, comp.allow);
      var r2 = root.AIGCEngine.applyCompliance(seg.subtitle, comp.terms, comp.mapping, comp.allow);
      seg.line = r1.text; seg.subtitle = r2.text;
      [r1.hits, r2.hits].forEach(function (h) {
        Object.keys(h).forEach(function (k) {
          detail[k] = (detail[k] || 0) + h[k];
          total += h[k];
        });
      });
    });

    return {
      total: total, detail: detail, allowSeen: allowSeen,
      baseCount: comp.base.length, extraCount: comp.extra.length,
      allow: comp.allow, mapping: comp.mapping
    };
  }

  /* 把模型 JSON 拼成页面需要的完整结果 */
  function assemble(parsed, base, params, templates) {
    var compliance = templates.sections.compliance;
    var platformRules = (compliance.platform_rules || {})[params.platform] || {};
    var comp = root.AIGCEngine.buildComplianceTable(compliance, params.platform);

    var result = {
      ctx: base.ctx,
      titles: coerceTitles(parsed.titles, base, params.count),
      sellingPoints: coerceSellingPoints(parsed.selling_points, base),
      csScripts: coerceCs(parsed.cs_scripts, base),
      video: coerceVideo(parsed.video, base),
      benchmark: base.benchmark,
      batch: base.batch
    };

    var summary = summarizeCompliance(result, comp);
    result.compliance = Object.assign(summary, { rules: platformRules });
    result.tstats = {
      overflow: 0,
      similar: 0,
      fallback: result.titles.filter(function (t) { return t.fallback; }).length
    };
    return result;
  }

  /* 模型有时会把 JSON 包在代码块或前后缀里，只取最外层对象 */
  function extractJson(text) {
    var t = String(text || '').trim();
    if (t.indexOf('```') === 0) {
      t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    }
    if (t.charAt(0) === '{') return t;
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) return t.slice(i, j + 1);
    return t;
  }

  root.__POST = {
    buildPrompt: buildPrompt,
    paramsFromProduct: paramsFromProduct,
    facetsOf: facetsOf,
    baseline: baseline,
    baselinePanel: baselinePanel,
    assemble: assemble,
    extractJson: extractJson,
    MAX_TITLE: MAX_TITLE,
    MAX_CS: MAX_CS
  };
})(window);
