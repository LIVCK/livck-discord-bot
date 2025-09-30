# Custom Status Dot Emojis

These emojis are used for status indicators in the layout views.

## Installation

### 1. Upload Emojis

1. Open your Discord Server Settings
2. Go to **Server Settings** → **Emoji**
3. Click **Upload Emoji**
4. Upload the following files:
   - `green_dot.png` → Name: `green_dot`
   - `red_dot.png` → Name: `red_dot`
   - `orange_dot.png` → Name: `orange_dot`

### 2. Get Emoji IDs

1. Type the following in a Discord channel:
   ```
   \:green_dot:
   \:red_dot:
   \:orange_dot:
   ```
2. Discord will show the IDs in format `<:name:1422681631268798657>`
3. Copy the IDs (numbers only)

### 3. Set Environment Variables

Add the emoji IDs to your `.env` file:

```env
EMOJI_GREEN_DOT=<:green_dot:YOUR_ID_HERE>
EMOJI_RED_DOT=<:red_dot:YOUR_ID_HERE>
EMOJI_ORANGE_DOT=<:orange_dot:YOUR_ID_HERE>
```

### 4. Restart Bot

```bash
# Restart the bot
pm2 restart discord-bot
# or
node server.js
```

## Colors

- **Green Dot** (#2ecc71): Operational
- **Red Dot** (#e74c3c): Critical/Down
- **Orange Dot** (#f39c12): Degraded/Warning

## Regenerate

To regenerate the emojis:

```bash
cd assets/emojis
python3 generate_status_dots.py
```

## Fallback

If no custom emojis are configured, the bot will automatically use Unicode emojis (🟢🔴🟠) as fallback.
