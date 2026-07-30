# Start from an official Node.js image (Debian-based, so apt-get works)
FROM node:20-bookworm-slim

# Install system-level tools our app depends on:
# - python3 + pip: needed to run yt-dlp
# - ffmpeg: needed for merging/trimming video
# - curl + unzip: needed to install Deno
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (--break-system-packages is required on newer Debian)
RUN pip3 install --break-system-packages yt-dlp

# Install Deno (needed for yt-dlp to solve YouTube's signature challenges)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Set up the app directory
WORKDIR /app

# Install Node dependencies first (better Docker layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Render sets $PORT automatically; our app already reads process.env.PORT
EXPOSE 5000

# Runs both index.js (API) and worker.js (background jobs) together
CMD ["npm", "start"]