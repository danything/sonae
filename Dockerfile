FROM oven/bun:1.4.4-slim AS base
WORKDIR /usr/src/app
EXPOSE 3000

FROM base AS builder
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun i --frozen-lockfile
COPY . .
# 公開のワークフローがコミットを渡す (開いているタブが古い版だと気づくのに使う予定)
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
RUN bun run build

# 配信用の distroless にはシェルが無いので、PVC を重ねるディレクトリはここで作り、持ち主ごと写す
FROM base AS rootfs
RUN mkdir -p /rootfs/data && chown 1000:1000 /rootfs/data

# 実行時の依存は無い: dependencies を空にしてあり、画面もサーバーも Vite が build/ に束ねる。
# node_modules をイメージに載せない (新しく足す依存も devDependencies に。dependencies に入れると
# 束ねられず、本番で見つからない)。
#
# 配信用は Bun の distroless (シェルもパッケージマネージャも無い)。uid 1000 で動かす
FROM oven/bun:1.4.4-distroless
WORKDIR /usr/src/app
ENV NODE_ENV=production SONAE_DATA=/data TZ=Asia/Tokyo
COPY --from=rootfs /rootfs/ /
COPY --from=builder --chown=1000:1000 /usr/src/app/package.json ./package.json
COPY --from=builder --chown=1000:1000 /usr/src/app/build ./build
USER 1000:1000
VOLUME /data
EXPOSE 3000
# 死活の確認は k8s のプローブ (/health) でする。
# ENTRYPOINT は bun そのもの (ベースのイメージと同じ)。CMD は引数だけにする
# (`CMD ["bun", "./build"]` だと `bun bun ./build` = `bun build` になって起動しない)
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["./build"]
