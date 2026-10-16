// ============================================================
//  文本净化：统一去除 emoji 与装饰性图标字形
//  - 覆盖真 emoji（Extended_Pictographic）、变体选择符、ZWJ、组合键帽
//  - 以及项目中用作图标的装饰字形（✦ ★ ◎ ☰ ◔ ◷ ⓘ ✓ ✗）
//  - 保留功能/数学符号：进度条 █░、箭头 →↓↑、• 圆点、Σ Δ τ ⌈⌉ ² 等
// ============================================================

const STRIP = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{2726}\u{2605}\u{2713}\u{2717}\u{2630}\u{25CE}\u{25D4}\u{25F7}\u{24D8}]/gu;

// 保留：█ U+2588、░ U+2591、• U+2022、→ U+2192、↓ U+2193、↑ U+2191 等
function stripEmoji(s) {
  if (s === null || s === undefined) return s;
  let out = String(s).replace(STRIP, '');
  // 清理因删字产生的残留空白：行首多余空格、连续空格、行尾空格
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
  return out;
}

module.exports = { stripEmoji, STRIP };
