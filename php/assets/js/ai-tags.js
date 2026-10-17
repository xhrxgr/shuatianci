/**
 * 标签字典查询。
 *
 * AI 返回的 tagIds 既有可能是 id、也可能是标签名，这里统一解析成标签对象，
 * 供「校验是否合法」与「预览显示标签名」两处共用。
 */


/** 把标签 id 或标签名解析成字典中的标签对象 */
export function resolveTag(tagDictionary, raw) {
  const key = raw.trim();
  if (!key) return null;
  return (
    tagDictionary.tags.find((tag) => tag.id === key) ??
    tagDictionary.tags.find((tag) => tag.name === key) ??
    null
  );
}
