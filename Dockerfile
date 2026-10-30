# ═════════════════════════ 构建阶段 ═════════════════════════
FROM node:22-slim AS build
WORKDIR /app

# 依赖层：只拷清单，改业务代码不用重装依赖（层缓存）
COPY package.json package-lock.json ./
RUN npm ci

# ⚠️ tsconfig 必须在 prisma generate 之前拷进来。
# prisma-client 生成器会读 tsconfig 推断 importFileExtension（.js 还是 .ts）。
# 找不到 tsconfig 时它退回 .ts，而 .ts 扩展名会被 tsc 原样保留进 dist，
# 运行时就会报：Cannot find module './internal/class.ts'
COPY tsconfig.json tsconfig.build.json nest-cli.json ./

# Prisma 必须在 build 之前生成：源码 import 了 ../../generated/prisma/client
COPY prisma ./prisma
COPY prisma.config.ts ./
# prisma.config.ts 用 env("DATABASE_URL") 读配置，缺值会直接抛错。
# 这里给一个只用于 codegen 的占位值，不会真的连库。
# 注意：generate 按「当前平台」产出查询引擎，所以在 Linux 构建时生成的是
# query_engine-debian-openssl-*.so.node，而不是本机那个 windows.dll.node。
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" npx prisma generate

# 编译
COPY src ./src
# scripts/seed.cjs 要在迁移阶段执行，所以必须进 build 阶段的文件系统
# （migrate 阶段由 FROM build 派生，能拿到这里的一切）
COPY scripts ./scripts
RUN npm run build

# ═════════════════════════ 迁移阶段 ═════════════════════════
# 从 build 直接派生：此刻 npm prune 还没执行，prisma CLI 完整可用。
# 这个镜像只为「一次性任务」存在 —— 建表 + 初始化数据，跑完进程退出。
# 它不进最终交付镜像（api/worker 用的是下面的 runtime 阶段）。
#
# 用 && 而不是 ;：迁移失败就别 seed 了，表都没建出来插数据只会更乱。
# 用 sh -c 包一层：JSON 数组形式不经过 shell，&& 不会被解释。
FROM build AS migrate
ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && node scripts/seed.cjs"]

# ═════════════════════════ 精简依赖阶段 ═════════════════════════
# 运行时不需要 tsc / jest / @nestjs/cli / prisma CLI，剔掉能省几百 MB。
# ⚠️ prune 必须发生在这里而不是 build 阶段 ——
#    否则 migrate 阶段就没有 prisma 命令了。
FROM build AS prod-deps
RUN npm prune --omit=dev

# ═════════════════════════ 运行阶段 ═════════════════════════
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 来源是 prod-deps（已 prune），不是 build
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# generated/ 必须一起带上：查询引擎是 .node 二进制，tsc 不会把它编进 dist。
# 编译后的 dist/generated/prisma/client.js 里有两个候选路径，
# 其中真实存在的是 process.cwd()/generated/prisma/（即 /app/generated/prisma/）。
COPY --from=build --chown=node:node /app/generated ./generated

COPY --from=build --chown=node:node /app/package.json ./package.json

# sourcemap 上传要往这里写（sourcemaps.service.ts 里是 mkdir recursive）。
# 不预先建好并交给 node，非 root 运行时会 EACCES: permission denied。
# 也可以改成 compose 挂具名卷：uploads:/app/uploads
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

# 非 root 运行：容器被攻破时拿不到宿主权限
USER node

EXPOSE 3000
# api 入口。worker 用同一个镜像，只把 CMD 换成 dist/src/worker.js
CMD ["node", "dist/src/main.js"]
