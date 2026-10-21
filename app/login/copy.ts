// 登录页的文字：只在这一页出现的话都在这里。报错的说法从 lib/error-copy.js 取。
// 页面文件不能导出常量，界面测试要引用这些话，所以放在同目录的 copy.ts（design/ui-copy-spec.md §12）；导入带 .js 后缀，node 可以直接读
import { BRAND } from "../../lib/brand.js";

export const COPY = Object.freeze({
  lead: "上游的余额和花费、自营站点的收入和利润，都在这一个控制台里看。",
  capsLabel: "能做什么",
  caps: Object.freeze(["看清每个上游的余额和可用天数", "每天算出收入、成本和利润", "余额快用完时及时提醒"]),
  foot: "每一笔上游花费都看得清",
  title: `登录${BRAND.productName}`,
  subtitle: "用管理员账号登录。",
  username: "用户名",
  password: "密码",
  submit: "登录",
  failed: "登录失败",
  notice: "只有这个控制台的管理员可以登录。",
});
