#!/usr/bin/env python3
"""
Generate small colored status dot emojis for Discord.
Creates 8x8 pixel PNG files in green, red, and orange/yellow colors.
"""

from PIL import Image, ImageDraw

def create_status_dot(color, filename):
    """Create a tiny colored dot emoji on 128x128 transparent canvas."""
    # Create 128x128 transparent canvas (Discord standard)
    size = 128
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)

    # Draw a small circle in the center (only 28x28 pixels)
    dot_size = 28
    center = size // 2
    offset = dot_size // 2
    circle_bbox = [
        center - offset,
        center - offset,
        center + offset,
        center + offset
    ]
    draw.ellipse(circle_bbox, fill=color)

    return img

# Define colors
colors = {
    'green': (46, 204, 113, 255),     # #2ecc71 - Operational
    'red': (231, 76, 60, 255),         # #e74c3c - Critical
    'orange': (243, 156, 18, 255),     # #f39c12 - Degraded/Warning
}

# Generate emoji files
for name, color in colors.items():
    img = create_status_dot(color, name)
    filename = f'{name}_dot.png'
    img.save(filename, 'PNG')
    print(f'Created: {filename}')

print('\nEmoji files generated successfully!')
print('Upload these to your Discord server to get emoji IDs.')
