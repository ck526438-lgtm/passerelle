FROM node:24-alpine

WORKDIR /app
COPY package.json rules.json ./
COPY src ./src
COPY web ./web

# Aucune dépendance runtime : rien à installer, l'image reste minuscule.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
