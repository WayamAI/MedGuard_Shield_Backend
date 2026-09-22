# syntax=docker/dockerfile:1

# Drishti API — multi-stage build.
#
# The build stage keeps devDependencies (TypeScript, Prisma CLI) and the
# runtime stage does not, so the shipped image carries neither a compiler nor
# a migration tool it does not need at request time.

# ---------------------------------------------------------------- base
FROM node:22-alpine AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL; alpine does not ship it by default and
# the failure it produces otherwise points nowhere near the cause.
RUN apk add --no-cache openssl

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts, then an explicit rebuild: npm 11 blocks install scripts by
# default, so without this the install "succeeds" while silently fetching
# neither the Prisma engine nor the esbuild binary.
RUN npm ci --ignore-scripts && npm rebuild prisma @prisma/engines esbuild

# ---------------------------------------------------------------- build
FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
# The Prisma client is generated output and gitignored, so it must be built
# before tsc can typecheck anything that imports it.
#
# prisma.config.ts resolves DATABASE_URL at module load and `prisma generate`
# loads that config -- but generate never opens a connection, so a placeholder
# satisfies it. This value exists only inside this build layer, is never
# present in the runtime stage, and must never be a real connection string:
# anything baked in here would be readable in the image history.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    npx prisma generate && npm run build

# ---------------------------------------------------------- runtime deps
FROM base AS runtime-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild prisma @prisma/engines

# ---------------------------------------------------------------- runner
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=4000

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Migrations and schema ship with the image so `migrate deploy` can run against
# the target database at release time.
COPY --from=build /app/prisma ./prisma
COPY prisma.config.ts package.json ./

# Run unprivileged. `node` already exists in the base image.
USER node

EXPOSE 4000

# Hits the public liveness route, which sits outside /api precisely so it
# needs no token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are NOT run on container start. A container that migrates as it
# boots will race every other replica during a rolling deploy; `migrate deploy`
# belongs in a release step. See DEPLOYMENT.md.
CMD ["node", "dist/server.js"]
