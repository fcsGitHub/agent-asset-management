// LIKE/ILIKE 字面量模式构造（M72，OWASP 注入预防「LIKE 通配符转义」口径）：
// 用户搜索词里的 % 与 _ 是 LIKE 元字符——直接拼模式时 `100%` 恒真匹配、`_` 任意单字符，
// 搜索语义失真。这里统一转义三个元字符（Postgres LIKE 默认转义符即反斜杠），
// 调用侧以 `ILIKE $n ESCAPE '\'` 显式声明。模式整体经 $n 参数下发，无拼接注入面。
export function likeContains(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}
