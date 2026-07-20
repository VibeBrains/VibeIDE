#!/bin/bash
# Create VibeIDE application icons from your logo
# This script will create all required icon formats for macOS, Windows, and Linux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$ROOT_DIR/resources"

echo "=========================================="
echo "VibeIDE Icon Generation Script"
echo "=========================================="
echo ""

# Check for logo file
LOGO_SVG="$ROOT_DIR/src/vs/workbench/browser/media/code-icon.svg"
LOGO_PNG=""

# Check if user provided a logo file
if [ -n "$1" ]; then
    if [ -f "$1" ]; then
        LOGO_PNG="$1"
        echo "Using provided logo: $LOGO_PNG"
    else
        echo "Error: Logo file not found: $1"
        exit 1
    fi
elif [ -f "$LOGO_SVG" ]; then
    echo "Found logo at: $LOGO_SVG"
    echo ""
    echo "To use your VibeIDE logo:"
    echo "1. Replace $LOGO_SVG with your logo (SVG format)"
    echo "2. Or provide a PNG file as an argument:"
    echo "   ./scripts/create-vibeide-icons.sh /path/to/your-logo.png"
    echo ""
    read -p "Do you want to use the current logo file? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Please provide your logo file:"
        echo "  ./scripts/create-vibeide-icons.sh /path/to/logo.png"
        exit 0
    fi
else
    echo "Error: No logo file found."
    echo ""
    echo "Please provide your VibeIDE logo:"
    echo "1. Option A: Replace $LOGO_SVG with your logo (SVG format)"
    echo "2. Option B: Run this script with your logo as argument:"
    echo "   ./scripts/create-vibeide-icons.sh /path/to/logo.png"
    exit 1
fi

# If we have SVG, we need to convert it to PNG first
if [ -z "$LOGO_PNG" ]; then
    # Check if we have SVG and need to convert
    if [ -f "$LOGO_SVG" ]; then
        echo ""
        echo "Converting SVG to PNG..."
        echo "NOTE: macOS 'sips' doesn't support SVG directly."
        echo ""
        echo "Please do one of the following:"
        echo "1. Open '$LOGO_SVG' in Preview or another app"
        echo "2. Export it as PNG at 1024x1024 pixels"
        echo "3. Save it as /tmp/vibeide-logo-1024.png"
        echo ""
        read -p "Press Enter when you've created the PNG file, or Ctrl+C to cancel..."

        LOGO_PNG="/tmp/vibeide-logo-1024.png"
        if [ ! -f "$LOGO_PNG" ]; then
            echo "Error: PNG file not found at $LOGO_PNG"
            echo "Please create it first (see instructions above)"
            exit 1
        fi
    fi
fi

# Verify PNG source exists
if [ ! -f "$LOGO_PNG" ]; then
    echo "Error: PNG source not found at $LOGO_PNG"
    exit 1
fi

# Verify it's a valid image
if ! sips -g pixelWidth "$LOGO_PNG" > /dev/null 2>&1; then
    echo "Error: Invalid image file or 'sips' cannot process it"
    exit 1
fi

# Get image dimensions
WIDTH=$(sips -g pixelWidth "$LOGO_PNG" | tail -1 | awk '{print $2}')
HEIGHT=$(sips -g pixelHeight "$LOGO_PNG" | tail -1 | awk '{print $2}')

echo ""
echo "Source image: ${WIDTH}x${HEIGHT}"
echo ""

# Ensure square and minimum size
if [ "$WIDTH" -lt 512 ] || [ "$HEIGHT" -lt 512 ]; then
    echo "Warning: Image is smaller than recommended 512x512"
    echo "For best results, use at least 1024x1024"
fi

# macOS: Create .icns file
echo "Creating macOS icon (.icns)..."
mkdir -p /tmp/vibeide.iconset

# Create a circular version of the logo first
CIRCULAR_SCRIPT="$SCRIPT_DIR/make-circular-icon.js"
CIRCULAR_LOGO="/tmp/vibeide-circular.png"
if [ -f "$CIRCULAR_SCRIPT" ] && command -v node > /dev/null 2>&1; then
    echo "  Making circular icon..."
    node "$CIRCULAR_SCRIPT" "$LOGO_PNG" "$CIRCULAR_LOGO" > /dev/null 2>&1
    if [ -f "$CIRCULAR_LOGO" ]; then
        LOGO_TO_USE="$CIRCULAR_LOGO"
        echo "  ✓ Circular icon created"
    else
        LOGO_TO_USE="$LOGO_PNG"
        echo "  ⚠ Could not create circular icon, using original"
    fi
else
    LOGO_TO_USE="$LOGO_PNG"
    echo "  ⚠ Circular icon script not available, using original"
fi

# Create all required icon sizes for macOS
sizes=(16 32 64 128 256 512)
for size in "${sizes[@]}"; do
    echo "  Creating ${size}x${size}..."
    # @1x version
    sips -z $size $size "$LOGO_TO_USE" --out "/tmp/vibeide.iconset/icon_${size}x${size}.png" > /dev/null 2>&1

    # @2x version (for Retina displays)
    size2x=$((size * 2))
    echo "  Creating ${size}x${size}@2x..."
    sips -z $size2x $size2x "$LOGO_TO_USE" --out "/tmp/vibeide.iconset/icon_${size}x${size}@2x.png" > /dev/null 2>&1
done

# 1024x1024 (single, not @2x, as it's the base)
echo "  Creating 1024x1024..."
sips -z 1024 1024 "$LOGO_TO_USE" --out "/tmp/vibeide.iconset/icon_1024x1024.png" > /dev/null 2>&1

# 1024x1024@2x (for Retina)
echo "  Creating 1024x1024@2x..."
sips -z 2048 2048 "$LOGO_TO_USE" --out "/tmp/vibeide.iconset/icon_1024x1024@2x.png" > /dev/null 2>&1

# Convert iconset to .icns
echo "Converting to .icns..."
iconutil -c icns /tmp/vibeide.iconset -o "$RESOURCES_DIR/darwin/code.icns" 2>/dev/null || {
    echo "Error: Failed to create .icns file"
    echo "Make sure all icon files were created correctly"
    exit 1
}

# Linux: Create PNG (512x512, but we'll use larger for better quality)
echo "Creating Linux icon (.png)..."
if [ -f "$CIRCULAR_LOGO" ]; then
    sips -z 512 512 "$CIRCULAR_LOGO" --out "$RESOURCES_DIR/linux/code.png" > /dev/null 2>&1
else
    sips -z 512 512 "$LOGO_PNG" --out "$RESOURCES_DIR/linux/code.png" > /dev/null 2>&1
fi

# Windows: Create PNG versions
echo "Creating Windows icon PNGs..."
if [ -f "$CIRCULAR_LOGO" ]; then
    sips -z 150 150 "$CIRCULAR_LOGO" --out "$RESOURCES_DIR/win32/code_150x150.png" > /dev/null 2>&1
    sips -z 70 70 "$CIRCULAR_LOGO" --out "$RESOURCES_DIR/win32/code_70x70.png" > /dev/null 2>&1
    sips -z 256 256 "$CIRCULAR_LOGO" --out "/tmp/vibeide-256.png" > /dev/null 2>&1
else
    sips -z 150 150 "$LOGO_PNG" --out "$RESOURCES_DIR/win32/code_150x150.png" > /dev/null 2>&1
    sips -z 70 70 "$LOGO_PNG" --out "$RESOURCES_DIR/win32/code_70x70.png" > /dev/null 2>&1
    sips -z 256 256 "$LOGO_PNG" --out "/tmp/vibeide-256.png" > /dev/null 2>&1
fi

# Create a high-res version for Windows .ico conversion
echo "Creating high-res PNG for Windows .ico conversion..."

# Try to create Windows .ico file automatically
echo "Creating Windows .ico file..."
ICO_SCRIPT="$SCRIPT_DIR/create-ico.js"
if [ -f "$ICO_SCRIPT" ] && command -v node > /dev/null 2>&1; then
    if node "$ICO_SCRIPT" "/tmp/vibeide-256.png" "$RESOURCES_DIR/win32/code.ico" 2>/dev/null; then
        echo "  ✓ Windows .ico created successfully"
        ICO_CREATED=true
    else
        echo "  ⚠ Could not create .ico automatically"
        ICO_CREATED=false
    fi
else
    echo "  ⚠ Skipping automatic .ico creation (Node.js script not found)"
    ICO_CREATED=false
fi

echo ""
echo "=========================================="
echo "✓ Icons created successfully!"
echo "=========================================="
echo ""
echo "Created files:"
echo "  ✓ macOS: $RESOURCES_DIR/darwin/code.icns"
echo "  ✓ Linux: $RESOURCES_DIR/linux/code.png"
echo "  ✓ Windows: code_150x150.png, code_70x70.png"
if [ "$ICO_CREATED" = true ]; then
    echo "  ✓ Windows: code.ico (multi-resolution)"
else
    echo ""
    echo "Windows .ico file still needs to be created:"
    echo "1. Visit https://convertio.co/png-ico/ or https://icoconvert.com/"
    echo "2. Upload: /tmp/vibeide-256.png (or your original logo)"
    echo "3. Make sure to include multiple sizes (16, 24, 32, 48, 64, 128, 256)"
    echo "4. Download and save as: $RESOURCES_DIR/win32/code.ico"
fi
echo ""
echo "After icons are ready, rebuild your application:"
echo "  npm run build"
echo ""

# Cleanup
rm -rf /tmp/vibeide.iconset
rm -f /tmp/vibeide-256.png /tmp/vibeide-circular.png
echo "Done!"
