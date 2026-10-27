# Development image: Node.js and the Tailwind standalone CLI.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL --retry 6 --retry-all-errors --retry-delay 5 -o /usr/local/bin/tailwindcss \
       https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.3/tailwindcss-linux-x64 \
    && chmod +x /usr/local/bin/tailwindcss \
    && rm -rf /var/lib/apt/lists/*
# The base image already has the "node" user with uid 1000.
RUN mkdir -p /app/node_modules && chown -R node:node /app
USER node
WORKDIR /app
EXPOSE 8000
CMD ["bin/dev"]
