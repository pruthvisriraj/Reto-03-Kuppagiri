FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY demo.ts tsconfig.json ./
RUN mkdir -p out && chown -R bun:bun out
USER bun
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/server.ts"]
