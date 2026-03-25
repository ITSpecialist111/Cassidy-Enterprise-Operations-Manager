FROM node:20-slim

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm install --production

# Copy compiled output (run `npm run build` before building the image)
COPY dist/ ./dist/

# Expose the agent port
EXPOSE 3978

# Production entrypoint
CMD ["node", "dist/index.js"]
