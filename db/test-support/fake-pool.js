// Store 单测用的假连接池：读库回给定的上游文档和通知渠道，写库什么都不做（测试里用 t.mock.method 盯着连接上的调用）
export function fakePool(stations = [], channels = [], settings = {}) {
  const conn = {
    beginTransaction: async () => {},
    query: async () => [[]],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  return {
    query: async (sql) => {
      if (sql.startsWith("SELECT id, doc FROM stations")) {
        return [stations.map((doc) => ({ id: doc.id, doc }))];
      }
      if (sql.startsWith("SELECT k, v FROM meta")) {
        return [[
          { k: "settings", v: settings },
          { k: "auth", v: { username: "admin", salt: "test", hash: "test" } },
          { k: "notifications", v: { channels: structuredClone(channels), rules: {} } },
        ]];
      }
      return [[]];
    },
    getConnection: async () => conn,
  };
}
