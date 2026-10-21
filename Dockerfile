# 中转站余额监控面板 v2（Next.js standalone + MySQL）
# ---- 构建阶段 ----------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 构建期不连库（运行时才初始化 MySQL）；占位值避免构建意外读到真实环境
ENV DB_HOST=build-placeholder
RUN npx next build

# ---- 运行阶段 ----------------------------------------------------------------
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8787

# tzdata 让 TZ 环境变量生效（只影响日志等进程本地时间）；利润、日汇总、日报按 BUSINESS_TIME_ZONE 划日，与 TZ 无关
RUN apk add --no-cache tzdata

# standalone 产物：自带裁剪后的 node_modules 与 server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 迁移脚本独立于 Next 构建图（防止真实凭证被文件追踪拷进产物），
# 启动时链式执行：库为空且配置了 V1_DATA_DIR 才导入，幂等。
# db/pool.js 要引用 lib/ 里的结账账本等纯函数（4a 起），lib/ 不在 standalone 产物里，要一起拷，
# 否则 node db/migrate.js 找不到模块直接退出，服务起不来（CI 的 image-smoke 会在镜像里加载一次）
COPY --from=builder /app/db ./db
COPY --from=builder /app/lib ./lib

# 构建时注入 git commit，页面「关于」显示
ARG GIT_SHA=dev
ENV APP_COMMIT=$GIT_SHA

EXPOSE 8787
# 健康检查打首页（登录壳，未登录也 200）；/api/meta 需要登录会 401 导致误报 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q --spider http://127.0.0.1:8787/ || exit 1

CMD ["sh", "-c", "node db/migrate.js && exec node server.js"]
