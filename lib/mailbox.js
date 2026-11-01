// 用户邮箱的校验（给重点用户发邮件用）：New API 的邮箱字段只限长度，用户可以随便填。
// 只收「一个干净的地址」：不含空白、尖括号、引号、括号、反斜杠和逗号分号（含全角），不超过 254 个字符。
// 含逗号、分号会被 SMTP 发信那一层拆成几个收件人，含回车换行或尖括号能往 SMTP 会话里塞命令，所以这些一律当没填邮箱。
const PART = String.raw`[^\s@<>,;，；"'()\\]+`;
const MAILBOX = new RegExp(`^${PART}@${PART}\\.${PART}$`);

export const MAILBOX_MAX_LENGTH = 254;

export function isMailbox(value) {
  return typeof value === "string" && value.length <= MAILBOX_MAX_LENGTH && MAILBOX.test(value);
}
