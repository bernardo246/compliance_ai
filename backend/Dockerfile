# Fase 6 — imagem de produção do backend (multi-stage).
#
# Segredos (.env, chaves JWT .pem) NUNCA entram na imagem: ficam no
# .dockerignore e são injetados em runtime via variáveis de ambiente.

# ---- Stage 1: build (precisa das devDependencies: nest CLI, typescript) ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY nest-cli.json tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: dependências só de produção ----
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 3: runtime enxuto ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Roda como usuário sem privilégios (o usuário `node` já existe na imagem).
USER node

EXPOSE 3001

CMD ["node", "dist/main"]
