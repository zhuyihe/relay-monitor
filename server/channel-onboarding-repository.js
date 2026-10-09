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

  async saveLinks(links) {
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
    if (!unique.size) return [];
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
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
