FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install production deps only (no package-lock.json required)
RUN npm install --omit=dev

# Copy source
COPY server.js ./

# Expose port (Railway/Render override via PORT env var)
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT:-5000}/health || exit 1

CMD ["node", "server.js"]
