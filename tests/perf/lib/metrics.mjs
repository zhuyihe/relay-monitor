// 稳态窗口里两个循环的轮数不一定一样多（结账轮询是「上一轮结束后再等 60 秒」），按轮折算才可比
export function perRound(bg) {
  const s = bg?.steady, r = bg?.refreshRound;
  if (!s || !r || !s.reconRounds?.length) return null;
  const sql = Math.round((s.sqlStatements - s.balanceRounds * r.sqlStatements) / s.reconRounds.length);
  const binlog = s.binlogBytes == null ? 0 : Math.round((s.binlogBytes - s.balanceRounds * (r.binlogBytes || 0)) / s.reconRounds.length);
  const rowsExamined = s.rowsExamined == null || r.rowsExamined == null ? null
    : Math.round((s.rowsExamined - s.balanceRounds * r.rowsExamined) / s.reconRounds.length);
  return { sql, binlog, rowsExamined, fake: Math.round((s.fakeRequests - s.balanceRounds * r.fakeRequests) / s.reconRounds.length) };
}
