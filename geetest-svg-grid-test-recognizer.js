/**
 * SVG 九宫格测试页面识别脚本（仅分析，不点击、不提交）
 * 原理：DOM 枚举帧图层 → 浏览器原生渲染 → 前景归一化 → 多特征匹配 → 置信度判定
 * 使用方法：在本地或自有测试页面的控制台中粘贴全部代码执行。
 */

(async function () {
  'use strict';

  const workflowStartedAt = performance.now();

  // 所有运行时日志均带 ISO 时间戳；不记录 Cookie、令牌或完整图像数据。
  const logger = {
    debug(message, details) { writeLog('debug', message, details); },
    info(message, details) { writeLog('info', message, details); },
    warn(message, details) { writeLog('warn', message, details); },
    error(message, details) { writeLog('error', message, details); }
  };

  function writeLog(level, message, details) {
    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
    const writer = typeof console[level] === 'function' ? console[level] : console.log;
    if (details === undefined) writer.call(console, `${prefix} ${message}`);
    else writer.call(console, `${prefix} ${message}`, details);
  }

  try {
  // ========== 配置参数 ==========
  const CONFIG = {
    renderSize: 96,          // 统一渲染尺寸；提高细线和抗锯齿稳定性
    normalizePadding: 8,     // 归一化后的四周留白
    colorBins: 8,            // 颜色直方图分箱数
    absoluteThreshold: 0.6,  // 绝对置信度阈值
    relativeGapThreshold: 0.15, // 相对差距阈值（最高分-次高分）/最高分
    featureWeights: {        // 各特征权重
      color: 0.25,
      contour: 0.45,
      areaRatio: 0.15,
      connected: 0.15
    }
  };

  // Canvas 在本流程中写入后不再修改，适合使用 WeakMap 缓存派生特征。
  const foregroundCache = new WeakMap();
  const histogramCache = new WeakMap();
  const huMomentCache = new WeakMap();
  const componentCountCache = new WeakMap();
  const cacheStats = {
    foregroundHits: 0,
    foregroundMisses: 0,
    histogramHits: 0,
    histogramMisses: 0,
    huHits: 0,
    huMisses: 0,
    componentHits: 0,
    componentMisses: 0
  };

  // ========== 1. 定位核心元素 ==========
  // 用固定data属性定位SVG，不受哈希类名影响
  const svg = document.querySelector('svg[data-captcha-type="geetest-svg"]');
  if (!svg) {
    throw new Error('未找到 SVG 九宫格测试组件');
  }

  // 提取三个帧图层（SVG直接子g，内部包含9个格子背景rect）
  const frameLayers = Array.from(svg.querySelectorAll(':scope > g')).filter(g => {
    return g.querySelectorAll(':scope > rect[rx]').length === 9;
  });
  if (frameLayers.length !== 3) {
    throw new Error(`帧图层数量异常：预期 3 个，实际 ${frameLayers.length} 个`);
  }
  logger.info('成功定位帧图层', { frameCount: frameLayers.length });

  // ========== 2. 工具函数 ==========
  /** 解析元素transform的translate值 */
  function getTranslate(el) {
    const transform = el.getAttribute('transform') || '';
    const number = '(-?\\d*\\.?\\d+(?:e[+-]?\\d+)?)';
    const match = transform.match(new RegExp(`translate\\(\\s*${number}\\s*(?:,|\\s)\\s*${number}`, 'i'));
    return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
  }

  /** 获取帧内的9个图形元素，按行列排序（行优先） */
  function getCellGraphics(frameLayer) {
    const graphics = Array.from(frameLayer.querySelectorAll(':scope > g[transform]')).filter(g => {
      return g.querySelector('path, circle, ellipse, rect, line, polyline, polygon, use') !== null;
    });
    return graphics.sort((a, b) => {
      const ta = getTranslate(a);
      const tb = getTranslate(b);
      if (Math.abs(ta.y - tb.y) > 1) return ta.y - tb.y;
      return ta.x - tb.x;
    });
  }

  /** 将单个 SVG 图形渲染为 Canvas 位图（透明背景）。 */
  function renderGraphicToCanvas(graphicEl, label, size = CONFIG.renderSize) {
    return new Promise((resolve, reject) => {
      const clone = graphicEl.cloneNode(true);
      // 单格节点本身没有帧动画；只禁用潜在动画，不覆盖原始透明度。
      clone.style.animation = 'none';
      clone.querySelectorAll('*').forEach(child => { child.style.animation = 'none'; });

      // 保留候选的 rotate/scale/translate(-24,-24)，仅抵消格子中心位移。
      const center = getTranslate(graphicEl);
      const svgNS = 'http://www.w3.org/2000/svg';
      const offscreenSvg = document.createElementNS(svgNS, 'svg');
      offscreenSvg.setAttribute('xmlns', svgNS);
      offscreenSvg.setAttribute('width', size);
      offscreenSvg.setAttribute('height', size);
      offscreenSvg.setAttribute('viewBox', '0 0 48 48');

      const wrapper = document.createElementNS(svgNS, 'g');
      wrapper.setAttribute('transform', `translate(${24 - center.x} ${24 - center.y})`);
      wrapper.appendChild(clone);
      offscreenSvg.appendChild(wrapper);

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        reject(new Error(`${label}：无法创建 2D Canvas 上下文`));
        return;
      }

      const img = new Image();
      const svgStr = new XMLSerializer().serializeToString(offscreenSvg);
      // 测试页 CSP 允许 data:；避免使用会被 img-src 拦截的 blob: URL。
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;

      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error(`${label}：SVG data URL 渲染失败`));
      img.src = dataUrl;
    });
  }

  /** 获取右上角目标图的 Canvas。 */
  function getTargetCanvas(size = CONFIG.renderSize) {
    return new Promise((resolve, reject) => {
      const targetImg = document.querySelector('.geetest_header img') || document.querySelector('[class*="ques_tips"] img');
      if (!targetImg) {
        reject(new Error('未找到目标示例图'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        reject(new Error('目标图：无法创建 2D Canvas 上下文'));
        return;
      }

      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('目标示例图加载失败'));
      img.src = targetImg.src;
    });
  }

  /** 将目标与候选按前景边界裁剪、等比缩放并居中到统一画布。 */
  function normalizeCanvas(sourceCanvas, size = CONFIG.renderSize, padding = CONFIG.normalizePadding) {
    const sourceFg = extractForeground(sourceCanvas);
    if (!sourceFg.foregroundCount || !sourceFg.bounds) {
      throw new Error('图像归一化失败：未检测到前景像素');
    }

    const { minX, minY, maxX, maxY } = sourceFg.bounds;
    const sourcePadding = 1;
    const sx = Math.max(0, minX - sourcePadding);
    const sy = Math.max(0, minY - sourcePadding);
    const sw = Math.min(sourceCanvas.width, maxX + sourcePadding + 1) - sx;
    const sh = Math.min(sourceCanvas.height, maxY + sourcePadding + 1) - sy;
    const usable = Math.max(1, size - padding * 2);
    const scale = Math.min(usable / sw, usable / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (size - dw) / 2;
    const dy = (size - dh) / 2;

    const normalized = document.createElement('canvas');
    normalized.width = size;
    normalized.height = size;
    const ctx = normalized.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('图像归一化失败：无法创建 2D Canvas 上下文');
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
    return normalized;
  }
  // ========== 3. 图像特征提取 ==========
  /** 提取前景掩码、质心、边界和前景占比；相同 Canvas 只读取一次像素。 */
  function extractForeground(canvas) {
    const cached = foregroundCache.get(canvas);
    if (cached) {
      cacheStats.foregroundHits++;
      return cached;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('前景提取失败：无法创建 2D Canvas 上下文');
    const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const mask = new Uint8Array(width * height);
    let fgCount = 0, sumX = 0, sumY = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 30) {
        const idx = i / 4;
        const x = idx % width;
        const y = Math.floor(idx / width);
        mask[idx] = 1;
        fgCount++;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const result = {
      data,
      mask,
      width,
      height,
      foregroundCount: fgCount,
      areaRatio: fgCount / (width * height),
      bounds: fgCount ? { minX, minY, maxX, maxY } : null,
      centroid: {
        x: fgCount ? sumX / fgCount : width / 2,
        y: fgCount ? sumY / fgCount : height / 2
      }
    };
    foregroundCache.set(canvas, result);
    cacheStats.foregroundMisses++;
    return result;
  }
  /** 计算颜色直方图余弦相似度 */
  function calcColorSim(canvas1, canvas2) {
    const bins = CONFIG.colorBins;
    const hist1 = getHist(canvas1, bins);
    const hist2 = getHist(canvas2, bins);
    let dot = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < hist1.length; i++) {
      dot += hist1[i] * hist2[i];
      n1 += hist1[i] ** 2;
      n2 += hist2[i] ** 2;
    }
    return n1 && n2 ? dot / Math.sqrt(n1 * n2) : 0;
  }

  function getHist(canvas, bins) {
    let cachedByBins = histogramCache.get(canvas);
    if (cachedByBins?.has(bins)) {
      cacheStats.histogramHits++;
      return cachedByBins.get(bins);
    }

    const fg = extractForeground(canvas);
    const hist = new Array(bins * 3).fill(0);
    const binSize = 256 / bins;
    let total = 0;
    for (let i = 0; i < fg.data.length; i += 4) {
      const pixelIndex = i / 4;
      if (!fg.mask[pixelIndex]) continue;
      hist[Math.min(bins - 1, Math.floor(fg.data[i] / binSize))]++;
      hist[bins + Math.min(bins - 1, Math.floor(fg.data[i + 1] / binSize))]++;
      hist[bins * 2 + Math.min(bins - 1, Math.floor(fg.data[i + 2] / binSize))]++;
      total++;
    }

    const normalized = total ? hist.map(value => value / total) : hist;
    if (!cachedByBins) {
      cachedByBins = new Map();
      histogramCache.set(canvas, cachedByBins);
    }
    cachedByBins.set(bins, normalized);
    cacheStats.histogramMisses++;
    return normalized;
  }
  /** 计算 Hu 不变矩轮廓相似度。 */
  function calcContourSim(fg1, fg2) {
    const hu1 = getCachedHuMoments(fg1);
    const hu2 = getCachedHuMoments(fg2);
    const log1 = hu1.map(v => -Math.sign(v) * Math.log10(Math.abs(v) + 1e-10));
    const log2 = hu2.map(v => -Math.sign(v) * Math.log10(Math.abs(v) + 1e-10));
    let dist = 0;
    for (let i = 0; i < 7; i++) dist += Math.abs(log1[i] - log2[i]);
    return 1 / (1 + dist);
  }

  function getCachedHuMoments(fg) {
    const cached = huMomentCache.get(fg);
    if (cached) {
      cacheStats.huHits++;
      return cached;
    }
    const moments = getHuMoments(fg.mask, fg.width, fg.height);
    huMomentCache.set(fg, moments);
    cacheStats.huMisses++;
    return moments;
  }
  function getHuMoments(mask, w, h) {
    let m00=0, m10=0, m01=0, m20=0, m02=0, m11=0;
    let m30=0, m03=0, m21=0, m12=0;
    for (let y=0; y<h; y++) {
      for (let x=0; x<w; x++) {
        if (mask[y*w+x]) {
          m00++; m10+=x; m01+=y;
          m20+=x*x; m02+=y*y; m11+=x*y;
          m30+=x*x*x; m03+=y*y*y;
          m21+=x*x*y; m12+=x*y*y;
        }
      }
    }
    if (!m00) return new Array(7).fill(0);
    const xb = m10/m00, yb = m01/m00;
    const u20 = m20/m00 - xb*xb;
    const u02 = m02/m00 - yb*yb;
    const u11 = m11/m00 - xb*yb;
    const u30 = m30/m00 - 3*xb*m20/m00 + 2*xb*xb*m10/m00;
    const u03 = m03/m00 - 3*yb*m02/m00 + 2*yb*yb*m01/m00;
    const u21 = m21/m00 - 2*xb*m11/m00 - yb*m20/m00 + 2*xb*xb*m01/m00;
    const u12 = m12/m00 - 2*yb*m11/m00 - xb*m02/m00 + 2*yb*yb*m10/m00;

    const n20 = u20 / m00**2;
    const n02 = u02 / m00**2;
    const n11 = u11 / m00**2;
    const n30 = u30 / m00**2.5;
    const n03 = u03 / m00**2.5;
    const n21 = u21 / m00**2.5;
    const n12 = u12 / m00**2.5;

    const hu = [];
    hu[0] = n20 + n02;
    hu[1] = (n20-n02)**2 + 4*n11**2;
    hu[2] = (n30-3*n12)**2 + (3*n21-n03)**2;
    hu[3] = (n30+n12)**2 + (n21+n03)**2;
    hu[4] = (n30-3*n12)*(n30+n12)*((n30+n12)**2 - 3*(n21+n03)**2)
            + (3*n21-n03)*(n21+n03)*(3*(n30+n12)**2 - (n21+n03)**2);
    hu[5] = (n20-n02)*((n30+n12)**2 - (n21+n03)**2)
            + 4*n11*(n30+n12)*(n21+n03);
    hu[6] = (3*n21-n03)*(n30+n12)*((n30+n12)**2 - 3*(n21+n03)**2)
            - (n30-3*n12)*(n21+n03)*(3*(n30+n12)**2 - (n21+n03)**2);
    return hu;
  }

  /** 计算连通域数量相似度。 */
  function calcConnectedSim(fg1, fg2) {
    const count1 = getCachedComponentCount(fg1);
    const count2 = getCachedComponentCount(fg2);
    const diff = Math.abs(count1 - count2);
    return Math.max(0, 1 - diff * 0.3);
  }

  function getCachedComponentCount(fg) {
    const cached = componentCountCache.get(fg);
    if (cached !== undefined) {
      cacheStats.componentHits++;
      return cached;
    }
    const count = countComponents(fg.mask, fg.width, fg.height);
    componentCountCache.set(fg, count);
    cacheStats.componentMisses++;
    return count;
  }
  function countComponents(mask, w, h) {
    const labels = new Int32Array(w*h);
    let label = 0;
    const parent = [];
    const find = x => { while(parent[x]!==x) { parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
    const union = (a,b) => { const ra=find(a), rb=find(b); if(ra!==rb) parent[rb]=ra; };

    for (let y=0; y<h; y++) {
      for (let x=0; x<w; x++) {
        const idx = y*w+x;
        if (!mask[idx]) continue;
        const left = x>0 ? labels[idx-1] : 0;
        const up = y>0 ? labels[idx-w] : 0;
        if (!left && !up) {
          label++;
          parent[label] = label;
          labels[idx] = label;
        } else if (left && !up) {
          labels[idx] = left;
        } else if (!left && up) {
          labels[idx] = up;
        } else {
          union(left, up);
          labels[idx] = left;
        }
      }
    }
    const roots = new Set();
    for (let i=0; i<labels.length; i++) {
      if (labels[i]>0) roots.add(find(labels[i]));
    }
    return roots.size;
  }

  // ========== 4. 主识别流程 ==========
  logger.info('开始渲染所有候选图形', { frameCount: frameLayers.length, expectedCellsPerFrame: 9 });

  const allFrameCells = [];
  for (let fi = 0; fi < frameLayers.length; fi++) {
    const graphics = getCellGraphics(frameLayers[fi]);
    if (graphics.length !== 9) {
      throw new Error(`帧 ${fi + 1} 格子数量异常：预期 9 个，实际 ${graphics.length} 个`);
    }

    const canvases = [];
    for (let ci = 0; ci < graphics.length; ci++) {
      const label = `帧 ${fi + 1} / 格 ${ci + 1}`;
      const rawCanvas = await renderGraphicToCanvas(graphics[ci], label);
      canvases.push(normalizeCanvas(rawCanvas));
    }
    allFrameCells.push(canvases);
    logger.info('候选帧渲染完成', { frame: fi + 1, cellCount: canvases.length });
  }

  const targetRawCanvas = await getTargetCanvas();
  const targetCanvas = normalizeCanvas(targetRawCanvas);
  const targetFg = extractForeground(targetCanvas);
  logger.info('目标图加载并归一化完成', {
    foregroundRatio: Number(targetFg.areaRatio.toFixed(4))
  });

  // 保留全部 27 个“帧 + 格子”候选，不再按相同行列跨帧合并。
  const results = [];
  for (let fi = 0; fi < allFrameCells.length; fi++) {
    for (let ci = 0; ci < allFrameCells[fi].length; ci++) {
      const canvas = allFrameCells[fi][ci];
      const fg = extractForeground(canvas);
      const colorSim = calcColorSim(targetCanvas, canvas);
      const contourSim = calcContourSim(targetFg, fg);
      const areaSim = 1 - Math.abs(targetFg.areaRatio - fg.areaRatio) /
        Math.max(targetFg.areaRatio, fg.areaRatio, 0.01);
      const connectedSim = calcConnectedSim(targetFg, fg);
      const totalScore =
        colorSim * CONFIG.featureWeights.color +
        contourSim * CONFIG.featureWeights.contour +
        areaSim * CONFIG.featureWeights.areaRatio +
        connectedSim * CONFIG.featureWeights.connected;

      const row = Math.floor(ci / 3) + 1;
      const col = (ci % 3) + 1;
      results.push({
        frame: fi + 1,
        row,
        col,
        position: `第${row}行第${col}列`,
        score: totalScore,
        colorSim,
        contourSim,
        areaSim,
        connectedSim
      });
    }
  }

  const ranked = [...results].sort((a, b) => b.score - a.score);
  if (ranked.length < 2) throw new Error(`候选数量不足：实际 ${ranked.length} 个`);
  const top1 = ranked[0];
  const top2 = ranked[1];
  const relativeGap = top1.score > 0 ? (top1.score - top2.score) / top1.score : 0;
  const trusted = top1.score >= CONFIG.absoluteThreshold &&
    relativeGap >= CONFIG.relativeGapThreshold;
  const elapsedMs = Math.round(performance.now() - workflowStartedAt);

  logger.info('识别计算完成', {
    candidateCount: ranked.length,
    elapsedMs,
    trusted
  });
  logger.info('特征缓存统计', { ...cacheStats });
  logger.info('最佳候选（仅测试输出，不点击、不提交）', {
    frame: top1.frame,
    row: top1.row,
    col: top1.col,
    position: top1.position,
    score: Number(top1.score.toFixed(4)),
    relativeGap: Number(relativeGap.toFixed(4)),
    features: {
      color: Number(top1.colorSim.toFixed(4)),
      contour: Number(top1.contourSim.toFixed(4)),
      areaRatio: Number(top1.areaSim.toFixed(4)),
      connected: Number(top1.connectedSim.toFixed(4))
    }
  });

  if (!trusted) {
    logger.warn('置信度不足，仅保留预测结果供测试分析', {
      absoluteThreshold: CONFIG.absoluteThreshold,
      relativeGapThreshold: CONFIG.relativeGapThreshold
    });
  }

  ranked.slice(0, 3).forEach((candidate, index) => {
    logger.info(`Top ${index + 1} 候选`, {
      frame: candidate.frame,
      row: candidate.row,
      col: candidate.col,
      score: Number(candidate.score.toFixed(4))
    });
  });

  window.geetestResult = {
    ok: true,
    trusted,
    best: top1,
    relativeGap,
    ranked,
    allScores: results,
    elapsedMs,
    mode: 'analysis-only-no-click-no-submit'
  };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const elapsedMs = Math.round(performance.now() - workflowStartedAt);
    logger.error('识别流程失败', {
      name: normalizedError.name,
      message: normalizedError.message,
      elapsedMs
    });
    window.geetestResult = {
      ok: false,
      error: { name: normalizedError.name, message: normalizedError.message },
      elapsedMs,
      mode: 'analysis-only-no-click-no-submit'
    };
  }
})();
