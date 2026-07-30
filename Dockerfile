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

# Render's secret files (/etc/secrets/...) are read-only, but yt-dlp needs
# to write updated session data back into the cookies file it reads from.
# So on startup, copy it to a writable location first, then launch both
# processes. YTDLP_COOKIES_FILE should point to /tmp/cookies.txt in Render's
# environment variables (not /etc/secrets/cookies.txt).
CMD sh -c "if [ -f /etc/secrets/cookies.txt ]; then cp /etc/secrets/cookies.txt /tmp/cookies.txt; fi; npm start"