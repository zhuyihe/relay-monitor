// Channel discovery and monitoring links contain no supplier credentials or Keys.
const CATALOGUE_KEY = "channel_onboarding_catalogue";

function asJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function linkFromRow(row) {
  return {
    ownStationId: row.own_station_id,
    channelId: Number(row.channel_id),
    stationId: row.station_id,
    channelRevision: row.channel_revision,
    confirmedAt: Number(row.confirmed_at_ms),
  };
}

const linkSet = (links) => JSON.stringify(links.map((link) => [link.stationId, link.channelRevision, link.confirmedAt])
  .sort(([a], [b]) => a.localeCompare(b)));

export class ChannelOnboardingRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async listLinks({ ownStationId, stationId } = {}) {
    const filters = [], values = [];
    if (ownStationId) { filters.push("own_station_id = ?"); values.push(ownStationId); }
    if (stationId) { filters.push("station_id = ?"); values.push(stationId); }
    const [rows] = await this.pool.query(
      `SELECT * FROM channel_monitor_links ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY own_station_id, channel_id, station_id`, values
    );
    return rows.map(linkFromRow);
  }

  async saveLinks(links, { guard = null, removals = [], expectedLinks = null, expectedSource = null } = {}) {
    const unique = new Map();
    for (const input of links) {
      const channelId = Number(input.channelId);
      const confirmedAt = input.confirmedAt ?? Date.now();
      if (!input.ownStationId || !input.stationId ||
          !Number.isSafeInteger(channelId) || channelId <= 0 ||
          typeof input.channelRevision !== "string" || !input.channelRevision || input.channelRevision.length > 128 ||
          !Number.isSafeInteger(confirmedAt) || confirmedAt < 0) {
        throw new Error("渠道监控关联无效");
      }
      const link = {
        ownStationId: String(input.ownStationId), channelId, stationId: String(input.stationId),
        channelRevision: input.channelRevision, confirmedAt,
      };
      unique.set(JSON.stringify([link.ownStationId, channelId, link.stationId]), link);
    }
    const removed = new Map();
    for (const input of removals) {
      if (!input.ownStationId || !input.stationId || !Number.isSafeInteger(input.channelId) || input.channelId <= 0 || !Array.isArray(expectedLinks)) {
        throw new Error("要去掉的看余额绑定不完整");
      }
      const link = { ownStationId: String(input.ownStationId), channelId: input.channelId, stationId: String(input.stationId) };
      const key = JSON.stringify([link.ownStationId, link.channelId, link.stationId]);
      if (unique.has(key)) throw new Error("同一个上游不能同时加上又去掉");
      removed.set(key, link);
    }
    if (!unique.size && !removed.size) return [];
    const channels = new Map();
    for (const link of [...unique.values(), ...removed.values()]) channels.set(JSON.stringify([link.ownStationId, link.channelId]), link);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      guard?.();
      // 渠道还没有任何绑定时也先锁住已保存的渠道列表，所有写入都排在同一把锁后面
      const [catalogueRows] = await conn.query("SELECT v FROM meta WHERE k = ? FOR UPDATE", [CATALOGUE_KEY]);
      if (expectedSource) {
        const catalogue = catalogueRows.length ? asJson(catalogueRows[0].v) : null;
        if (!catalogue || catalogue.ownStationId !== expectedSource.ownStationId || catalogue.sourceVersion !== expectedSource.sourceVersion
            || catalogue.ownSource?.namespaceKey !== expectedSource.namespaceKey || expectedSource.channels.some((expected) => !catalogue.channels.some((channel) =>
              channel.id === expected.channelId && channel.revision === expected.channelRevision && !channel.missing))) {
          throw Object.assign(new Error("自营站点的渠道列表变了，请重新预览"), { code: "PREVIEW_BASIS_CHANGED" });
        }
      }
      // 只加不删的调用也锁同样的渠道范围，顺序一致，免得互相等死
      for (const [, channel] of [...channels].sort(([a], [b]) => a.localeCompare(b))) {
        const [rows] = await conn.query(
          "SELECT * FROM channel_monitor_links WHERE own_station_id = ? AND channel_id = ? ORDER BY station_id FOR UPDATE",
          [channel.ownStationId, channel.channelId]
        );
        if (expectedLinks && linkSet(rows.map(linkFromRow)) !== linkSet(expectedLinks.filter((link) => link.ownStationId === channel.ownStationId && link.channelId === channel.channelId))) {
          throw Object.assign(new Error("渠道看余额绑的上游变了，请重新预览"), { code: "PREVIEW_BASIS_CHANGED" });
        }
      }
      for (const link of removed.values()) {
        await conn.query("DELETE FROM channel_monitor_links WHERE own_station_id = ? AND channel_id = ? AND station_id = ?",
          [link.ownStationId, link.channelId, link.stationId]);
      }
      for (const link of unique.values()) {
        await conn.query(
          `INSERT INTO channel_monitor_links
           (own_station_id, channel_id, station_id, channel_revision, confirmed_at_ms) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           confirmed_at_ms = IF(channel_revision = VALUES(channel_revision), confirmed_at_ms, VALUES(confirmed_at_ms)),
           channel_revision = VALUES(channel_revision)`,
          [link.ownStationId, link.channelId, link.stationId, link.channelRevision, link.confirmedAt]
        );
      }
      const saved = [];
      for (const link of unique.values()) {
        const [rows] = await conn.query(
          "SELECT * FROM channel_monitor_links WHERE own_station_id = ? AND channel_id = ? AND station_id = ?",
          [link.ownStationId, link.channelId, link.stationId]
        );
        saved.push(linkFromRow(rows[0]));
      }
      guard?.();
      await conn.commit();
      return saved;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async getCatalogue() {
    const [rows] = await this.pool.query("SELECT v FROM meta WHERE k = ?", [CATALOGUE_KEY]);
    return rows.length ? asJson(rows[0].v) : null;
  }

  async saveCatalogue(catalogue) {
    await this.pool.query(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [CATALOGUE_KEY, JSON.stringify(catalogue)]
    );
    return catalogue;
  }
}
