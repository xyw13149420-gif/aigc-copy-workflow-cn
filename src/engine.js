/* AIGC 文案生成引擎 —— aigc_copywriter.py 的前端移植版
 * 关键点：内置 CPython 3.13 的 MT19937 随机数实现，保证同一 seed
 * 在浏览器里生成的结果与命令行脚本逐字一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIGCEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TITLE_CHARS = 30;
  const MAX_CS_CHARS = 80;
  const TITLE_COUNT = 5;
  const SP_COUNT = 6;
  const CS_SCENES = ['售前', '物流', '售后', '催付'];
  const SIMILARITY_THRESHOLD = 0.80;
  const TEMPLATE_BUILD_MINUTES = 45;

  const MANUAL_STEPS = [['需求理解与卖点梳理', 45], ['标题与卖点撰写', 165], ['话术与口播撰写', 90], ['审校与合规复核', 0]];
  const COLLAB_STEPS = [['输入参数', 15], ['脚本生成', 3], ['话术与口播同一批生成', 0], ['审校与合规复核', 120]];

  // ------------------------------------------------------------ MT19937
  const N = 624, M = 397, MATRIX_A = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff;

  class PyRandom {
    constructor(seed) {
      this.mt = new Uint32Array(N);
      this.index = N;
      this._initByArray(PyRandom.seedToKey(seed));
    }
    // CPython: keyused = bits==0 ? 1 : (bits-1)/32 + 1，按 32 位字小端切分
    static seedToKey(seed) {
      let v = Math.abs(Math.trunc(seed));
      const bits = v === 0 ? 0 : Math.floor(Math.log2(v)) + 1;
      const keyused = bits === 0 ? 1 : Math.floor((bits - 1) / 32) + 1;
      const key = [];
      for (let i = 0; i < keyused; i++) { key.push(v % 4294967296); v = Math.floor(v / 4294967296); }
      return key;
    }
    _initGenrand(s) {
      const mt = this.mt;
      mt[0] = s >>> 0;
      for (let i = 1; i < N; i++) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
      }
      this.index = N;
    }
    _initByArray(key) {
      this._initGenrand(19650218);
      const mt = this.mt;
      let i = 1, j = 0;
      let k = Math.max(N, key.length);
      for (; k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (k = N - 1; k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
        i++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      }
      mt[0] = 0x80000000;
    }
    _uint32() {
      const mt = this.mt;
      if (this.index >= N) {
        let kk;
        for (kk = 0; kk < N - M; kk++) {
          const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
          mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
        }
        for (; kk < N - 1; kk++) {
          const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
          mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0);
        }
        const y2 = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
        mt[N - 1] = mt[M - 1] ^ (y2 >>> 1) ^ ((y2 & 1) ? MATRIX_A : 0);
        this.index = 0;
      }
      let y = mt[this.index++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }
    getrandbits(k) { return this._uint32() >>> (32 - k); }
    randbelow(n) {
      const k = n.toString(2).length;
      let r = this.getrandbits(k);
      while (r >= n) r = this.getrandbits(k);
      return r;
    }
    randint(a, b) { return a + this.randbelow(b - a + 1); }
    choice(seq) { return seq[this.randbelow(seq.length)]; }
    shuffle(x) {
      for (let i = x.length - 1; i > 0; i--) {
        const j = this.randbelow(i + 1);
        const t = x[i]; x[i] = x[j]; x[j] = t;
      }
      return x;
    }
    sample(population, k) {
      const n = population.length;
      const result = new Array(k);
      let setsize = 21;
      if (k > 5) setsize += Math.pow(4, Math.ceil(Math.log(k * 3) / Math.log(4)));
      if (n <= setsize) {
        const pool = population.slice();
        for (let i = 0; i < k; i++) {
          const j = this.randbelow(n - i);
          result[i] = pool[j];
          pool[j] = pool[n - i - 1];
        }
      } else {
        const selected = new Set();
        for (let i = 0; i < k; i++) {
          let j = this.randbelow(n);
          while (selected.has(j)) j = this.randbelow(n);
          selected.add(j);
          result[i] = population[j];
        }
      }
      return result;
    }
  }

  // ------------------------------------------------------------ 基础工具
  // 词池为空时不该抽：randbelow(0) 会死循环，这里退成空串让上层跳过
  const pick = (rng, pool) => (pool && pool.length ? rng.choice(pool) : '');
  const fill = (tpl, ctx) => tpl.replace(/\{([^{}]*)\}/g, (m, key) => (key in ctx ? String(ctx[key]) : m));
  const normalize = (t) => t.replace(/[^0-9a-zA-Z\u4e00-\u9fff%]/g, '').toLowerCase();

  /* 商品里没有的字段（比如赠品=无）在 ctx 里是空串：这类模板整条跳过，
     否则会出现「送」「还送，今天下单」这种断句 */
  function hasEmptySlot(pattern, ctx) {
    const keys = pattern.match(/\{([^{}]+)\}/g);
    if (!keys) return false;
    return keys.some((s) => {
      const k = s.slice(1, -1);
      return k in ctx && (ctx[k] === '' || ctx[k] === undefined || ctx[k] === null);
    });
  }

  const hasGift = (ctx) => Boolean(ctx && ctx['赠品']);

  /* 单一成分商品的品名里已经有这个成分（豆腐渣 / 豆腐混合猫砂），
     再套「{核心成分}{product}」就是「豆腐渣豆腐混合猫砂」了。
     按前两个字判断，不要求整词相等。 */
  function coreRedundant(pattern, ctx, pools) {
    if (pattern.trim().indexOf('{核心成分}') !== 0) return false;
    return (pools.ingredient || []).some((i) => i && i.length >= 2 && ctx.product.indexOf(i.slice(0, 2)) >= 0);
  }

  function bigrams(text) {
    const s = new Set();
    for (let i = 0; i < text.length - 1; i++) s.add(text.slice(i, i + 2));
    return s;
  }

  function tooSimilar(a, b) {
    if (a === b) return true;
    const ga = bigrams(a), gb = bigrams(b);
    if (!ga.size || !gb.size) return false;
    let inter = 0;
    ga.forEach((g) => { if (gb.has(g)) inter++; });
    const union = ga.size + gb.size - inter;
    return inter / union >= SIMILARITY_THRESHOLD;
  }

  const fmtPrice = (v) => (v === null || v === undefined || v === '') ? '129' : String(Number(v));

  function priceInBand(price, band) {
    if (!band || band === 'all') return true;
    const m = /^(\d+)-(\d+)$/.exec(String(band));
    if (!m) return true;
    return Number(m[1]) <= price && price <= Number(m[2]);
  }

  /* 标题里只放短人群词：先看 --audience，再看商品名关键词，都没有才从词池抽。
     物种决定用哪套词：狗粮不能掉出「室内猫」 */
  const AUD_RULES = {
    dog: [['幼', '幼犬'], ['老年', '老年犬'], ['中大型', '中大型犬'], ['大型', '大型犬'],
          ['小型', '小型犬'], ['绝育', '绝育犬'], ['掉毛', '掉毛犬'], ['犬', '成犬']],
    cat: [['幼', '幼猫'], ['老年', '老年猫'], ['绝育', '绝育猫'], ['室内', '室内猫'],
          ['多猫', '多猫家庭'], ['犬', '成犬'], ['猫', '成猫']],
  };

  function deriveAudienceShort(audience, product, pools, rng) {
    const text = (audience || '') + ' ' + (product || '');
    const rules = /犬|狗/.test(text) ? AUD_RULES.dog : AUD_RULES.cat;
    for (const [key, word] of rules) if (text.indexOf(key) >= 0) return word;
    return pick(rng, pools.audience);
  }

  // ------------------------------------------------------------ 上下文
  function buildContext(opts, pools, rng) {
    const product = (opts.product || '').trim();
    const spec = opts.spec ? String(opts.spec).trim() : pick(rng, pools.spec);
    // 品类/物种词汇由适配层传入（宠物主粮 / 猫砂 / 零食 的量词与称呼都不同）
    const lex = (opts.overrides && opts.overrides.lexicon) || opts.lexicon || {};
    const word = (k, d) => (lex[k] === undefined || lex[k] === null || lex[k] === '') ? d : String(lex[k]);
    return {
      brand: pick(rng, pools.brand),
      product: product,
      spec: spec,
      price: fmtPrice(opts.price),
      audience: opts.audience ? String(opts.audience).trim() : '',
      '核心成分': pick(rng, pools.ingredient),
      '功能': pick(rng, pools.function),
      '人群': opts.audienceShort ? String(opts.audienceShort).trim()
                              : deriveAudienceShort(opts.audience, product, pools, rng),
      '场景': pick(rng, pools.scene),
      '数字卖点': pick(rng, pools.number_proof),
      '赠品': pick(rng, pools.gift) || '',
      '仓': pick(rng, pools.warehouse),
      '天数': '2-3',
      '运单号': 'SF' + rng.randint(100000000, 999999999),
      '城市': pick(rng, pools.city),
      '售后政策': pick(rng, pools.aftersale_policy),
      '库存': pick(rng, pools.stock),
      '物种': word('物种', '猫咪'),
      '量词': word('量词', '袋'),
      '形态': word('形态', '颗粒'),
      '品类': word('品类', ''),
      species: word('species', /犬|狗/.test(product) ? '犬' : '猫'),
      kind: word('kind', 'dry'),   // 没接商品时按主粮语境渲染，与命令行默认一致
    };
  }

  // ------------------------------------------------------------ 标题
  function genTitles(templates, ctx, pools, price, rng, count) {
    count = count || TITLE_COUNT;
    let pool = templates.filter((t) => priceInBand(price, t.price_band));
    if (pool.length < count) pool = templates.slice();
    const primary = pool.filter((t) => t.tier === 'long' || t.tier === 'mid');
    let short = pool.filter((t) => t.tier === 'short');
    if (!short.length) short = pool.slice().sort((a, b) => a.pattern.length - b.pattern.length).slice(0, 3);
    rng.shuffle(primary);
    rng.shuffle(short);

    const titles = [], keys = [];
    const stats = { overflow: 0, similar: 0, fallback: 0 };

    for (const tpl of primary.concat(short)) {
      if (titles.length >= count) break;
      if (hasEmptySlot(tpl.pattern, ctx) || coreRedundant(tpl.pattern, ctx, pools)) continue;
      const local = Object.assign({}, ctx);
      local['核心成分'] = pick(rng, pools.ingredient);
      local['功能'] = pick(rng, pools.function);
      local['数字卖点'] = pick(rng, pools.number_proof);
      const text = fill(tpl.pattern, local).replace(/\s+/g, ' ').trim();
      if (text.length > MAX_TITLE_CHARS) { stats.overflow++; continue; }
      const key = normalize(text);
      if (keys.some((k) => tooSimilar(key, k))) { stats.similar++; continue; }
      titles.push({ text, template: tpl.id, tier: tpl.tier || '', band: tpl.price_band || 'all', chars: text.length, fallback: false });
      keys.push(key);
    }

    let guard = 0;
    const specs = pools.spec.slice();
    while (titles.length < count && guard < 400) {
      const tpl = short[guard % short.length];
      if (hasEmptySlot(tpl.pattern, ctx) || coreRedundant(tpl.pattern, ctx, pools)) { guard++; continue; }
      const local = Object.assign({}, ctx, { spec: specs[guard % specs.length] });
      local['功能'] = pick(rng, pools.function);
      local['数字卖点'] = pick(rng, pools.number_proof);
      const text = fill(tpl.pattern, local).replace(/\s+/g, ' ').trim();
      guard++;
      if (text.length > MAX_TITLE_CHARS) { stats.overflow++; continue; }
      const key = normalize(text);
      if (keys.some((k) => tooSimilar(key, k))) { stats.similar++; continue; }
      titles.push({ text, template: tpl.id, tier: 'short', band: tpl.price_band || 'all', chars: text.length, fallback: true });
      keys.push(key);
      stats.fallback++;
    }
    return { titles, stats };
  }

  // ------------------------------------------------------------ 卖点 / 话术 / 口播
  /* 卖点：接了真实商品时，由适配层按 attributes.functions 预生成六条
     （功能决定说哪件事，证据与数值来自商品字段），这里直接采用，
     否则走原来的「随机抽结构 + 抽变量」路径 */
  function genSellingPoints(section, ctx, rng, n, preset) {
    n = n || SP_COUNT;
    if (preset && preset.length) {
      return preset.slice(0, n).map((item) => ({
        id: item.id,
        category: item.category || '',
        text: item.text,
        parts: Object.assign({ '痛点': '', '证据': '', '结果': '', '数字': '' }, item.parts),
      }));
    }
    n = Math.min(n, section.length);
    return rng.sample(section.slice(), n).map((item) => {
      const local = Object.assign({}, ctx, { pain: item.pain, evidence: item.evidence, result: item.result, number: item.number });
      return {
        id: item.id,
        category: item.category || '',
        text: fill(item.template, local),
        parts: { '痛点': item.pain, '证据': item.evidence, '结果': item.result, '数字': item.number },
      };
    });
  }

  function genCsScripts(section, ctx, rng) {
    const out = [];
    // 品类对不上的场景直接跳过：猫砂不写换粮软便，零食不写换粮过渡
    const usable = section.filter((c) => !c.kinds || !ctx.kind || c.kinds.indexOf(ctx.kind) >= 0);
    for (const scene of CS_SCENES) {
      const cands = usable.filter((c) => c.scene === scene);
      if (!cands.length) continue;
      rng.shuffle(cands);
      let chosen = null, over = null;
      for (const cand of cands) {
        // 没有赠品的商品，用不带赠品的版本，别把「还送」说出来又说不出送什么
        const tpl = (!hasGift(ctx) && cand.template_no_gift) ? cand.template_no_gift : cand.template;
        if (hasEmptySlot(tpl, ctx)) continue;
        const text = fill(tpl, ctx);
        const limit = cand.max_chars || MAX_CS_CHARS;
        if (text.length <= limit) { chosen = { cand, text, limit, over: false }; break; }
        over = { cand, text, limit, over: true };
      }
      if (!chosen) chosen = over;
      if (!chosen) continue;
      out.push({ id: chosen.cand.id, scene, text: chosen.text, chars: chosen.text.length,
                 limit: chosen.limit, over: chosen.over });
    }
    return out;
  }

  function genVideo(section, ctx) {
    // 品类决定拍什么（粮/罐/砂/零食），物种决定怎么说话（犬主粮不说泡软）
    const all = section.variants || {};
    const variant = all[(ctx.kind || '') + '|' + (ctx.species || '')] || all[ctx.kind] || null;
    const segs = (variant && variant.segments) || section.segments || [];
    const gift = hasGift(ctx);
    return {
      id: section.id || 'V01',
      total: section.total_seconds || 25,
      ratio: section.ratio || '9:16',
      segments: segs.map((seg) => ({
        range: seg.range, stage: seg.stage,
        line: fill(gift ? seg.line : (seg.line_no_gift || seg.line), ctx),
        subtitle: fill(gift ? (seg.subtitle || '') : (seg.subtitle_no_gift || seg.subtitle || ''), ctx),
        visual: (seg.visual || []).map((v) => fill(v, ctx)),
      })),
    };
  }

  // ------------------------------------------------------------ 合规
  function buildComplianceTable(compliance, platform) {
    const base = (compliance.banned_terms || []).slice();
    const extra = ((compliance.platform_extra_terms || {})[platform] || []).filter((t) => base.indexOf(t) < 0);
    const terms = base.concat(extra);
    const mapping = Object.assign({}, compliance.replace_map || {}, compliance.platform_extra_replace || {});
    return { terms, mapping, allow: (compliance.allow_terms || []).slice(), base, extra };
  }

  function applyCompliance(text, terms, mapping, allowTerms) {
    let masked = text;
    const marks = [];
    allowTerms.forEach((word, idx) => {
      if (masked.indexOf(word) >= 0) {
        const token = '\u0001' + idx + '\u0001';
        marks.push([token, word]);
        masked = masked.split(word).join(token);
      }
    });
    const hits = {};
    terms.slice().sort((a, b) => b.length - a.length).forEach((term) => {
      if (masked.indexOf(term) >= 0) {
        let count = 0;
        const parts = masked.split(term);
        count = parts.length - 1;
        hits[term] = count;
        masked = parts.join(mapping[term] !== undefined ? mapping[term] : '（此处删去极限表述）');
      }
    });
    marks.forEach(([token, word]) => { masked = masked.split(token).join(word); });
    return { text: masked, hits };
  }

  function repairTitles(titles, templates, ctx, pools, rng, terms, mapping, allowTerms) {
    const hits = {};
    let repaired = 0;
    let short = templates.filter((t) => t.tier === 'short');
    if (!short.length) short = templates.slice();
    const specs = pools.spec.slice();

    titles.forEach((item) => {
      if (item.text.length <= MAX_TITLE_CHARS) return;
      const parts = item.text.split(' ');
      while (parts.join(' ').length > MAX_TITLE_CHARS && parts.length > 2) parts.pop();
      let text = parts.join(' ');
      if (text.length > MAX_TITLE_CHARS) { text = text.slice(0, MAX_TITLE_CHARS); item.truncated = true; }
      item.text = text; item.chars = text.length;
      item.repaired = true;
      repaired++;
    });

    const seen = {};
    titles.forEach((item, idx) => {
      const key = normalize(item.text);
      if (!(key in seen)) { seen[key] = idx; return; }
      const pickable = short.filter((t) => !hasEmptySlot(t.pattern, ctx) && !coreRedundant(t.pattern, ctx, pools));
      if (!pickable.length) { seen[key] = idx; return; }
      const tpl = pickable[(repaired + idx) % pickable.length];
      const local = Object.assign({}, ctx, { spec: specs[idx % specs.length] });
      let text = fill(tpl.pattern, local).replace(/\s+/g, ' ').trim();
      const res = applyCompliance(text, terms, mapping, allowTerms);
      text = res.text;
      Object.keys(res.hits).forEach((k) => { hits[k] = (hits[k] || 0) + res.hits[k]; });
      Object.assign(item, { text, chars: text.length, template: tpl.id, tier: tpl.tier || 'short',
                            band: tpl.price_band || 'all', fallback: true, repaired: true });
      seen[normalize(text)] = idx;
    });
    return { repaired, hits };
  }

  // ------------------------------------------------------------ 主流程
  function generate(templatesData, opts) {
    const sections = templatesData.sections;
    const compliance = sections.compliance;
    // 接入真实商品时，用商品库的字段顶替词池（品牌/配料/功能/赠品等），
    // 表达仍由模板或模型决定，但商品事实不再被随机抽取改写。
    const pools = opts.overrides && opts.overrides.pools
      ? Object.assign({}, sections.variable_pools, opts.overrides.pools)
      : sections.variable_pools;
    const platform = opts.platform || 'tmall';
    const platformRules = (compliance.platform_rules || {})[platform] || {};
    const price = opts.price === undefined || opts.price === '' ? 129 : Number(opts.price);
    const count = Number(opts.count) || TITLE_COUNT;
    const seed = Number(opts.seed === undefined ? 7 : opts.seed);

    const rng = new PyRandom(seed);
    const ctx = buildContext(opts, pools, rng);
    const comp = buildComplianceTable(compliance, platform);

    const t = genTitles(sections.title_templates, ctx, pools, price, rng, count);
    const titles = t.titles, tstats = t.stats;
    const preset = opts.overrides && opts.overrides.selling;
    const sps = genSellingPoints(sections.selling_points, ctx, rng, SP_COUNT, preset);
    const css = genCsScripts(sections.cs_scripts, ctx, rng);
    const video = genVideo(sections.video_script, ctx);

    let compTotal = 0;
    const compDetail = {};
    const allowSeen = {};

    const countAllow = (text) => {
      comp.allow.forEach((w) => {
        let idx = text.indexOf(w), c = 0;
        while (idx >= 0) { c++; idx = text.indexOf(w, idx + w.length); }
        if (c) allowSeen[w] = (allowSeen[w] || 0) + c;
      });
    };

    const scan = (item) => {
      countAllow(item.text);
      const res = applyCompliance(item.text, comp.terms, comp.mapping, comp.allow);
      item.text = res.text;
      if ('chars' in item) item.chars = item.text.length;
      Object.keys(res.hits).forEach((k) => {
        compDetail[k] = (compDetail[k] || 0) + res.hits[k];
        compTotal += res.hits[k];
      });
    };

    titles.forEach(scan);
    sps.forEach(scan);
    css.forEach(scan);
    video.segments.forEach((seg) => {
      countAllow(seg.line + ' ' + seg.subtitle);
      const r1 = applyCompliance(seg.line, comp.terms, comp.mapping, comp.allow);
      const r2 = applyCompliance(seg.subtitle, comp.terms, comp.mapping, comp.allow);
      seg.line = r1.text; seg.subtitle = r2.text;
      [r1.hits, r2.hits].forEach((h) => Object.keys(h).forEach((k) => {
        compDetail[k] = (compDetail[k] || 0) + h[k];
        compTotal += h[k];
      }));
    });

    const rep = repairTitles(titles, sections.title_templates, ctx, pools, rng,
                             comp.terms, comp.mapping, comp.allow);
    tstats.repaired = rep.repaired;
    Object.keys(rep.hits).forEach((k) => {
      compDetail[k] = (compDetail[k] || 0) + rep.hits[k];
      compTotal += rep.hits[k];
    });

    return {
      ctx, titles, tstats, sellingPoints: sps, csScripts: css, video,
      compliance: {
        total: compTotal, detail: compDetail, allowSeen,
        baseCount: comp.base.length, extraCount: comp.extra.length,
        allow: comp.allow, mapping: comp.mapping, rules: platformRules,
      },
      meta: { seed, platform, count, price, product: ctx.product },
      benchmark: benchmark(),
      batch: batchTable(),
    };
  }

  // ------------------------------------------------------------ 耗时测算
  function benchmark() {
    const manual = MANUAL_STEPS.reduce((s, x) => s + x[1], 0);
    const collab = COLLAB_STEPS.reduce((s, x) => s + x[1], 0);
    const rows = MANUAL_STEPS.map((m, i) => ({
      stage: m[0], manual: m[1], collabName: COLLAB_STEPS[i][0],
      collab: COLLAB_STEPS[i][1], delta: COLLAB_STEPS[i][1] - m[1],
    }));
    return { manual, collab, rows, savePct: (manual - collab) / manual * 100 };
  }

  function batchTable(sizes) {
    sizes = sizes || [1, 20, 50, 100];
    const bm = benchmark();
    return sizes.map((n) => {
      const manual = bm.manual * n / 60;
      const withBuild = bm.collab * n / 60 + TEMPLATE_BUILD_MINUTES;
      return { n, manual, withBuild, perPiece: withBuild / n, savePct: (manual - withBuild) / manual * 100 };
    });
  }

  return { generate, benchmark, batchTable, PyRandom, applyCompliance, buildComplianceTable,
           MAX_TITLE_CHARS, MAX_CS_CHARS, TEMPLATE_BUILD_MINUTES };
});
