/* 品类 / 物种适配层
 *
 * 解决问题：模板库原来只有一套猫粮语境。选「三文鱼燕麦成犬粮」会掉出「幼猫」人群，
 * 选「豆腐混合猫砂」会掉出「换粮软便」卖点和「温水泡 3 分钟」口播。
 *
 * 这里只做一件事：把一条真实商品记录，翻译成引擎能用的参数
 *   pools    词池（品牌 / 成分 / 功能 / 人群 / 场景 / 赠品 / 库存 …）全部来自商品字段
 *   lexicon  量词与形态（袋 / 罐 / 包、颗粒 / 肉泥 / 砂粒）和物种称呼（猫咪 / 狗狗 / 毛孩子）
 *   selling  六条卖点：功能词决定说哪件事，商品证据与真实数值填进去
 *
 * 商品里没有的，宁可留空让上层跳过对应模板，也不从猫粮词池里猜一个。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.__FACETS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CAT_RE = /猫/;
  var DOG_RE = /犬|狗/;
  var DROP_ING = /^(水分|灰分|粗蛋白|粗脂肪|粗纤维|磷|钙|盐|钠)$/;

  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  /* 品类：先看砂，再看罐/湿粮，再看粮，最后才是零食（冻干粮要按粮算） */
  function kindOf(p) {
    var t = str(p.category) + ' ' + str(p.name);
    if (/砂|垫料|尿垫/.test(t)) return 'litter';
    if (/罐|湿粮|餐包|汤包|主食包/.test(t)) return 'wet';
    if (/零食|肉干|肉条|猫条|狗条|奖励|磨牙/.test(t)) return 'treat';
    if (/粮|主食|奶糕/.test(t)) return 'dry';
    if (/冻干/.test(t)) return 'treat';
    return 'other';
  }

  function speciesOf(p) {
    var t = str(p.category) + ' ' + str(p.name) + ' ' + str(p.audience) + ' ' + str(p.spec);
    var cat = CAT_RE.test(t), dog = DOG_RE.test(t);
    if (cat && dog) return '猫犬';
    if (dog) return '犬';
    return '猫';
  }

  /* 「鲜鸡肉 38%」→「鲜鸡肉」：百分比留给证据位，标题里不塞数字 */
  function cleanIng(s) {
    return str(s)
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/\s*\d+(?:\.\d+)?\s*%/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  /* 「鲜鸡肉 38%」里的 38；没写占比的排后面 */
  function pctOf(p, cleanName) {
    var list = (p.attributes || {}).ingredients || [];
    for (var i = 0; i < list.length; i++) {
      if (cleanIng(list[i]) !== cleanName) continue;
      var m = /(\d+(?:\.\d+)?)\s*%/.exec(String(list[i]));
      return m ? Number(m[1]) : 0;
    }
    return 0;
  }

  function ingredients(p) {    var a = p.attributes || {};
    var out = [];
    (a.ingredients || []).forEach(function (raw) {
      var v = cleanIng(raw);
      if (!v || DROP_ING.test(v)) return;
      if (out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }

  function splitList(v) {
    return str(v).split(/[\/、，,;；|＋+]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* 人群：从商品 audience 里取最像「人群」的那一段，取不出就按品类兜一个 */
  function audiences(p, species, kind) {
    var list = splitList(p.audience).map(function (s) {
      return s.replace(/主人$/, '').replace(/[，,。]$/, '').trim();
    }).filter(function (s) { return s && s.length <= 12; });
    if (list.length) return list;
    if (kind === 'litter') return ['养猫家庭'];
    var name = str(p.name);
    var stage = /幼/.test(name) ? '幼' : (/老年|高龄/.test(name) ? '老年' : '全阶段');
    return [stage + (species === '猫犬' ? '猫犬' : species)];
  }

  /* 客观证据：整段 proof 是「默认证据」，拆出来的短句只在与卖点对得上时才用
     （否则会出现「…看这条：高于国标成猫粮 25% 的下限」这种半截话） */
  function evidences(p, ings) {
    var a = p.attributes || {};
    var whole = str(a.proof).replace(/\s+/g, ' ').replace(/[。；;]$/, '').trim();
    if (whole.length > 34) whole = whole.slice(0, 34).replace(/[，,、]$/, '');
    var clauses = [];
    var combos = [];
    var push = function (arr, s) {
      s = str(s).replace(/\s+/g, ' ').replace(/[。；;，,、]$/, '').trim();
      if (!s || s.length > 26 || arr.indexOf(s) >= 0) return;
      arr.push(s);
    };
    str(a.proof).split(/[。；;]/).forEach(function (seg) {
      seg.split(/[，,]/).forEach(function (c) { push(clauses, c); });
    });
    if (ings.length >= 2) {
      push(combos, ings.slice(0, 2).join(' + '));
      if (ings.length >= 3) push(combos, ings[0] + ' + ' + ings[2]);
    }
    if (ings.length === 1) push(combos, '配料表只有' + ings[0]);
    if (!whole && !clauses.length) push(clauses, (a.functions || []).join(' / '));
    return { whole: whole, clauses: clauses, combos: combos };
  }

  /* 证据和这条卖点说的是不是一件事：按二字组重合度挑，同分取更短的那句 */
  function pickEvidence(ev, matter, i) {
    var pool = (ev.clauses || []).concat(ev.combos || []);
    var grams = function (t) {
      var s = {};
      for (var k = 0; k < t.length - 1; k++) s[t.slice(k, k + 2)] = 1;
      return s;
    };
    var target = grams(matter);
    var best = '', bestScore = 0;
    pool.forEach(function (c) {
      var g = grams(c), n = 0;
      Object.keys(g).forEach(function (x) { if (target[x]) n++; });
      if (n > bestScore || (n === bestScore && n > 0 && c.length < best.length)) { best = c; bestScore = n; }
    });
    if (bestScore > 0) return best;
    // 没有对得上的短句：整段依据与配料组合交替用，别六条卖点引同一句
    var alt = (ev.whole ? [ev.whole] : []).concat(ev.combos || []);
    return alt.length ? alt[i % alt.length] : '';
  }

  /* 可引用的真实数值：只要实测值（proof_short / 蛋白 / 脂肪）。
     规格不属于「实测」，塞进「实测{number}」会变成「实测 2.5kg × 4 包」 */
  function numbers(p) {
    var a = p.attributes || {};
    var out = [];
    var seen = {};
    var push = function (s) {
      s = str(s).replace(/\s+/g, ' ').trim();
      if (!s || s === '-' || s === '—') return;
      var key = s.replace(/\s+/g, '');     // 「粗蛋白38%」与「粗蛋白 38%」是同一个数
      if (seen[key]) return;
      seen[key] = 1;
      out.push(s);
    };
    push(a.proof_short);
    push(a.protein && a.protein !== '-' ? '粗蛋白 ' + a.protein : '');
    push(a.fat && a.fat !== '-' ? '粗脂肪 ' + a.fat : '');
    return out;
  }

  /* 句子收尾：证据/结果缺失时留下的空括号、重复逗号、逗号接句号，统一在这里清掉 */
  function tidy(text) {
    return text
      .replace(/^[，,、。；;\s]+/, '')
      .replace(/[？?][，,]/g, function (m) { return m.charAt(0); })
      .replace(/[。！!][，,]/g, function (m) { return m.charAt(0); })
      .replace(/[，,]{2,}/g, '，')
      .replace(/【\s*】/g, '')
      .replace(/[，,]\s*（\s*）/g, '')
      .replace(/[，,]\s*（/g, '（')
      .replace(/[，,]\s*。$/, '。')
      .replace(/[：:]\s*[，,。]/g, '。')
      .replace(/([，。：；])\s+([A-Za-z])/g, '$1$2')   // 「， Omega-3」→「，Omega-3」
      .replace(/（\s+([A-Za-z])/g, '（$1');           // 「（ Omega-3」→「（Omega-3」
  }

  /* 数字位只放对得上的数值：讲蛋白就引蛋白，讲体态才引脂肪。
     对不上的宁可不写，也别让「毛球」后面挂「粗脂肪 16%」 */
  var NUM_RULES = [
    [/高蛋白|蛋白|增肌|长肉/, ['蛋白']],
    [/控体重|低脂|体重|体态/, ['脂肪', 'kcal', '能量']],
    [/美毛|亮毛|化毛|毛球|毛发/, ['Omega', 'Ω', '鱼油', '卵磷脂', '牛磺酸']],
    [/关节|骨骼|运动/, ['葡萄糖胺', '软骨素', '钙']],
    [/无谷|低敏|单一/, ['谷物', '无谷', '单一', '配料表']],
    [/消化|肠胃|软便|益生|吸收|便/, ['益生', '纤维', '菌']],
    [/补水|汤|湿粮|罐/, ['水分', '汤', '含肉']],
    [/粉尘|结团|除臭|冲厕|带出|砂/, ['粉尘', '结团', '除臭', '秒']],
    [/训练|奖励|零食/, ['蛋白', '配料表']]
  ];

  var squash = function (t) { return str(t).replace(/\s+/g, ''); };

  /* 两句话说的是不是同一件事：二字组重合度 ≥ 0.6 就算 */
  function sameThing(a, b) {
    var g = function (t) {
      var s2 = {}, t2 = squash(t);
      for (var k = 0; k < t2.length - 1; k++) s2[t2.slice(k, k + 2)] = 1;
      return s2;
    };
    var ga = g(a), gb = g(b), keys = Object.keys(gb);
    if (!keys.length) return false;
    var hit = 0;
    keys.forEach(function (k) { if (ga[k]) hit++; });
    return hit / keys.length >= 0.6;
  }

  /* 证据里已经写过的数字不再重复一遍（「粗蛋白 38%，…（粗蛋白38%）」） */
  var digitsOf = function (t) {
    var m = str(t).match(/\d+(?:\.\d+)?%?/g);
    return m ? m : [];
  };

  function numberFor(fn, nums, used, evidence, spent) {
    var inEvidence = {};
    digitsOf(evidence).forEach(function (d) { inEvidence[d] = 1; });
    Object.keys(spent || {}).forEach(function (d) { inEvidence[d] = 1; });
    var free = nums.filter(function (n) {
      if (used[squash(n)]) return false;
      var d = digitsOf(n);
      // 证据里已经出现过这个数值（哪怕措辞不同）就不再重复
      return !(d.length && d.every(function (x) { return inEvidence[x]; }));
    });
    for (var k = 0; k < NUM_RULES.length; k++) {
      if (!NUM_RULES[k][0].test(fn)) continue;
      var keys = NUM_RULES[k][1];
      for (var j = 0; j < free.length; j++) {
        for (var m = 0; m < keys.length; m++) {
          if (free[j].indexOf(keys[m]) >= 0) { used[squash(free[j])] = 1; return free[j]; }
        }
      }
    }
    return '';
  }

  /* 六条卖点：功能词（商品 attributes.functions）决定说哪件事。
     商品自带的 3 个功能词先讲，并挂上它的真实依据；不够 6 条时，
     用同品类/同物种的补充角度只讲结果（不挂证据，避免张冠李戴） */
  function sellingPoints(p, templates) {
    var S = (templates && templates.sections) || {};
    var lib = S.function_library || {};
    var frames = S.selling_frames || [];
    var a = p.attributes || {};
    var kind = kindOf(p), species = speciesOf(p);

    var solid = [];
    (a.functions || []).map(str).forEach(function (f) {
      if (f && solid.indexOf(f) < 0 && solid.length < 6) solid.push(f);
    });
    var soft = [];
    var cands = dim((S.demo_pools || {}).selling_function, kind, species) || [];
    for (var c = 0; c < cands.length && solid.length + soft.length < 6; c++) {
      var f2 = str(cands[c]);
      if (f2 && solid.indexOf(f2) < 0 && soft.indexOf(f2) < 0) soft.push(f2);
    }
    if (!solid.length && !soft.length) solid = ['__fallback'];

    var ings = ingredients(p);
    var ev = evidences(p, ings);
    var nums = numbers(p);
    var used = {};
    var spent = {};   // 已经在前几条里出现过的数值，别重复
    var fallback = lib.__fallback || { label: '综合', pain: '同类款买了不合用', result: '按真实参数挑，少走弯路' };

    var out = [];
    var total = solid.length + soft.length;
    for (var i = 0; i < total && i < 6; i++) {
      var isSolid = i < solid.length;
      var fn = isSolid ? solid[i] : soft[i - solid.length];
      var mat = lib[fn] || fallback;
      var softFrames = S.selling_frames_soft || [];
      var frame = isSolid
        ? (frames.length ? frames[i % frames.length] : { id: 'F00', template: '{pain}？{evidence}，{result}（{number}）。' })
        : (softFrames.length ? softFrames[(i - solid.length) % softFrames.length] : { id: 'S0', template: '{pain}？{result}。' });
      var evidence = isSolid ? pickEvidence(ev, fn + mat.pain + mat.result, i) : '';
      // 证据里已经说明了结果（「车前子壳帮助毛球随粪便排出」+「毛球随粪便排出」）就不再重复一遍
      var result = (evidence && (evidence.indexOf(mat.result) >= 0 || sameThing(evidence, mat.result))) ? '' : mat.result;
      var number = isSolid ? numberFor(fn, nums, used, evidence, spent) : '';
      digitsOf(evidence).concat(digitsOf(number)).forEach(function (d) { spent[d] = 1; });
      var parts = {
        '痛点': mat.pain,
        '证据': evidence,
        '结果': result || mat.result,
        '数字': number,
      };
      /* 证据位缺失时不硬编：这句话就不说证据，只保留痛点 → 结果 */
      var tpl = number ? frame.template : (frame.template_no_num || frame.template);
      var text = tidy(
        tpl
          .replace('{pain}', parts['痛点'])
          .replace('{evidence}', evidence ? evidence + '，' : '')
          .replace('{result}', result ? result + '，' : '')
          .replace('{number}', number)
      );
      out.push({
        id: 'P' + (i + 1),
        category: mat.label,
        text: text,
        parts: parts,
        fn: fn,
        frame: frame.id,
      });
    }
    return out;
  }

  /* ================================================================
   * 参数面板：没有商品记录时，从「商品名 / 目标人群」里认出品类与物种
   * 面板上的字就是唯一的输入，所以这里不许再回落到猫粮词池。
   * ================================================================ */

  function byText(t) {
    t = str(t);
    var dog = /犬|狗/.test(t), cat = /猫/.test(t);
    if (dog && cat) return '猫犬';
    if (dog) return '犬';
    if (cat) return '猫';
    return '';
  }

  /* 商品名优先：面板上写「狗粮」，就是狗；写「猫砂」，就是猫 */
  function speciesFromText(name, audience) {
    return byText(name) || byText(audience) || '猫';
  }

  /* 示例词池是两层的：{dry:{犬:[...]}} 或 {猫:[...]} 或 [...]，统一取一维 */
  function dim(pool, kind, species) {
    if (!pool) return [];
    if (Object.prototype.toString.call(pool) === '[object Array]') return pool;
    var sub = (kind && pool[kind] !== undefined) ? pool[kind] : null;
    if (sub) {
      if (Object.prototype.toString.call(sub) === '[object Array]') return sub;
      if (sub[species]) return sub[species];
      return sub['猫'] || sub['猫犬'] || [];
    }
    if (pool[species]) return pool[species];
    return [];
  }

  function rotate(arr, n) {
    if (!arr || !arr.length) return [];
    var k = Math.abs(Number(n) || 0) % arr.length;
    return arr.slice(k).concat(arr.slice(0, k));
  }

  /* 人群短词：只留能塞进标题的那几个字（室内猫 / 中大型犬 …） */
  var AUD_RULES = {
    猫: [['幼', '幼猫'], ['老年', '老年猫'], ['绝育', '绝育猫'], ['室内', '室内猫'], ['多猫', '多猫家庭'], ['掉毛', '掉毛猫']],
    犬: [['幼', '幼犬'], ['老年', '老年犬'], ['中大型', '中大型犬'], ['大型', '大型犬'], ['小型', '小型犬'], ['绝育', '绝育犬'], ['掉毛', '掉毛犬']],
    猫犬: [['幼', '幼宠'], ['老年', '老年宠']],
  };

  function shortAudience(text, species) {
    var t = str(text);
    var rules = AUD_RULES[species] || AUD_RULES['猫犬'];
    for (var i = 0; i < rules.length; i++) if (t.indexOf(rules[i][0]) >= 0) return rules[i][1];
    return '';
  }

  /* 面板卖点：功能决定说哪件事，依据按功能给，数字轮换，六条不重样 */
  function demoSelling(species, kind, seed, sections) {
    var P = sections.demo_pools || {};
    var lib = sections.function_library || {};
    var frames = sections.selling_frames || [];
    var fns = rotate(dim(P.selling_function || P.function, kind, species), seed);
    var ings = dim(P.ingredient, kind, species);
    var nums = rotate(dim(P.number_proof, kind, species), seed);
    var proofs = dim(P.proof, kind, species) || {};
    var numberFor = dim(P.number_for, kind, species) || {};
    if (!fns.length) fns = ['__fallback'];

    var out = [];
    for (var i = 0; i < 6; i++) {
      var fn = fns[i % fns.length];
      var mat = lib[fn] || lib.__fallback || { label: '综合', pain: '同类款买了不合用', result: '按真实参数挑，少走弯路' };
      var frame = frames.length ? frames[i % frames.length] : { id: 'F00', template: '{pain}？{evidence}，{result}（{number}）。' };
      var ev = proofs[fn] || (ings.length >= 2 ? ings.slice(0, 2).join(' + ') : (ings[0] || ''));
      var num = numberFor[fn] || (nums.length ? nums[i % nums.length] : '');
      // 依据里已经写过的数值不再重复一遍
      var evDigits = digitsOf(ev);
      if (num && digitsOf(num).length && digitsOf(num).every(function (d) { return evDigits.indexOf(d) >= 0; })) num = '';
      // 数字以字母开头（Omega-3）时补一个空格：「实测 Omega-3 1.2%」不黏字
      var numText = /^[A-Za-z]/.test(num) ? ' ' + num : num;
      var text = tidy(
        (num ? frame.template : (frame.template_no_num || frame.template))
          .replace('{pain}', mat.pain)
          .replace('{evidence}', ev ? ev + '，' : '')
          .replace('{result}', mat.result + '，')
          .replace('{number}', numText)
      );
      out.push({
        id: 'P' + (i + 1),
        category: mat.label,
        text: text,
        parts: { '痛点': mat.pain, '证据': ev, '结果': mat.result, '数字': num },
        fn: fn,
        frame: frame.id,
      });
    }
    return out;
  }

  /* 参数面板 → 一条「临时商品记录」→ 与真实商品走同一个 derive() */
  function fromParams(params, templates) {
    var sections = (templates && templates.sections) || {};
    var P = sections.demo_pools;
    if (!P) return null;

    var name = str(params.product);
    var typed = str(params.audience);
    var kind = kindOf({ name: name });
    var species = speciesFromText(name, typed);
    // 认不出品类的（羊奶粉、营养膏…）按主粮语境兜底：词池空着会让引擎抽不到值
    if (kind !== 'dry' && !dim(P.ingredient, kind, species).length) kind = 'dry';
    var seed = Math.abs(Number(params.seed) || 0);

    var ings = rotate(dim(P.ingredient, kind, species), seed);
    // 名字里点名的食材排到最前：手输「鸭肉干」却配「三文鱼」是最容易露馅的错配
    var named = [];
    ['dry', 'wet', 'treat', 'litter'].forEach(function (k) {
      (dim(P.ingredient, k, species) || []).forEach(function (w) {
        if (w && name.indexOf(w) >= 0 && named.indexOf(w) < 0) named.push(w);
      });
    });
    (name.match(/[\u4e00-\u9fa5]{1,3}肉/g) || []).forEach(function (w) {
      if (named.indexOf(w) < 0) named.push(w);
    });
    if (named.length) {
      ings = named.concat(ings.filter(function (w) { return named.indexOf(w) < 0; }));
    }
    var fns = rotate(dim(P.function, kind, species), seed);
    var nums = rotate(dim(P.number_proof, kind, species), seed);
    var scenes = rotate(dim(P.scene, kind, species), seed);
    var gifts = rotate(dim(P.gift, kind, species), seed);
    var brands = rotate(dim(P.brand, kind, species), seed);
    var brandPool = [];
    ['dry', 'wet', 'treat', 'litter'].forEach(function (k) {
      brandPool = brandPool.concat(dim(P.brand, k, species) || []);
    });
    var brandHit = brandPool.filter(function (b) { return b && name.indexOf(b) >= 0; })[0] || '';
    var specs = dim(P.spec, kind, species);
    var proofs = dim(P.proof, kind, species) || {};

    /* 人群：先看面板写的，物种对不上就按商品的物种重写，不能让狗粮写着「室内猫」 */
    var aud = '';
    var conflict = false;
    var plain = typed.replace(/主人$/, '').replace(/[，,。]$/, '').trim();
    if (plain) {
      var hasCat = /猫/.test(plain), hasDog = /犬|狗/.test(plain);
      conflict = (species === '犬' && hasCat && !hasDog) || (species === '猫' && hasDog && !hasCat);
      if (!conflict) aud = shortAudience(plain, species) || (plain.length <= 10 ? plain : '');
    }
    if (!aud) {
      var pool = dim(P.audience, kind, species);
      aud = rotate(pool, seed)[0] || (species === '犬' ? '成犬' : '成猫');
    }

    var spec = str(params.spec) || (specs[0] || '');
    var gift = gifts[0] || '无';
    var proof = proofs[fns[0]] || (ings.length >= 2 ? ings.slice(0, 2).join(' + ')
      : (ings[0] ? '配料表只有' + ings[0] : ''));

    var product = {
      name: name,
      brand: brandHit,
      spec: spec,
      audience: aud,
      price: params.price,
      attributes: {
        ingredients: ings,
        functions: fns,
        proof: proof,
        proof_short: nums[0] || '',
        scene: scenes.join(' / '),
        gift: gift,
      },
    };

    var f = derive(product, templates, { kind: kind, species: species });
    if (!f) return null;
    f.source = 'panel';
    // 把合成出来的临时商品一起带出去：页面生成文案、算提示词都要用同一个「商品」，不能各拿一份
    f.product = product;
    f.pools.spec = spec ? [spec] : (specs.length ? specs : ['1.8kg']);
    f.pools.number_proof = nums.length ? nums.slice() : [''];
    f.pools.audience = [aud];
    f.selling = demoSelling(species, kind, seed, sections);
    f.audienceNote = { typed: typed, used: aud, conflict: conflict };
    return f;
  }

  /* hint：面板已经认出品类/物种时直接用它，别让 derive 再按品名猜一遍 */
  function derive(product, templates, hint) {
    if (!product) return null;
    var p = product;
    var S = (templates && templates.sections) || {};
    var species = (hint && hint.species) || speciesOf(p);
    var kind = (hint && hint.kind) || kindOf(p);
    var spLex = (S.species_lexicon || {})[species] || { word: '宠物', owner: '宠物主人' };
    var kLex = (S.kind_lexicon || {})[kind] || { word: '商品', unit: '件', form: '实物' };
    var a = p.attributes || {};
    var ings = ingredients(p);
    var gift = str(a.gift);

    var pools = {};
    pools.brand = p.brand ? [str(p.brand)] : [''];   // 空串占位：engine 要从这个池里取，没有会抽空
    if (p.spec) pools.spec = [str(p.spec)];
    /* 核心成分：按配料表占比从高到低排，品名里已经有的词往后排
       （避免「燕麦三文鱼燕麦成犬粮」，但第一位的主料始终保留，免得只剩辅料） */
    var ranked = ings.slice().sort(function (x, y) {
      var px = pctOf(p, x), py = pctOf(p, y);
      return py - px;
    });
    var nameStr = str(p.name);
    /* 品名里点名的配料就是核心成分：写「鸭肉干」不该在标题里出现「鸡胸肉」 */
    var nameHits = ranked.filter(function (i) { return i && nameStr.indexOf(i) >= 0; });
    var kept = nameHits.length
      ? nameHits
      : (ranked.length
        ? [ranked[0]].concat(ranked.slice(1).filter(function (i) { return nameStr.indexOf(i.slice(0, 2)) < 0; }))
        : []);
    pools.ingredient = kept;
    // 商品没写的维度一律留空串：引擎会跳过引用它的模板，绝不回落到猫粮词池
    pools.function = (a.functions || []).map(str).filter(Boolean);
    pools.audience = audiences(p, species, kind);
    var scene = splitList(a.scene);
    if (scene.length) pools.scene = scene;
    pools.gift = (gift && gift !== '无') ? [gift] : [''];
    var nums = numbers(p);
    pools.number_proof = nums.length ? [nums[0]] : [''];
    if (p.warehouse) pools.warehouse = [str(p.warehouse)];
    if (p.stock !== undefined && p.stock !== null && p.stock !== '') pools.stock = [String(p.stock)];

    return {
      species: species,
      speciesWord: spLex.word,
      kind: kind,
      kindWord: kLex.word,
      unit: kLex.unit,
      form: kLex.form,
      lexicon: {
        '物种': spLex.word,
        '量词': kLex.unit,
        '形态': kLex.form,
        '品类': kLex.word,
        species: species,
        kind: kind,
      },
      pools: pools,
      selling: sellingPoints(p, templates),
      /* 供提示词使用的事实摘要 */
      facts: {
        species: species,
        speciesWord: spLex.word,
        kind: kind,
        kindWord: kLex.word,
        unit: kLex.unit,
        form: kLex.form,
        ingredients: ings,
        functions: (a.functions || []).slice(),
        audience: audiences(p, species, kind),
        scene: scene,
        proof: str(a.proof),
        numbers: numbers(p),
        gift: (gift && gift !== '无') ? gift : '',
      },
    };
  }

  return {
    derive: derive,
    fromParams: fromParams,
    kindOf: kindOf,
    speciesOf: speciesOf,
    speciesFromText: speciesFromText,
    sellingPoints: sellingPoints,
  };
});
