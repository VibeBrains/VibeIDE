#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *	Copyright (c) Microsoft Corporation. All rights reserved.
 *	Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Create a multi-resolution Windows .ico file from a PNG source

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2] || '/tmp/vibeide-256.png';
const outputPath = process.argv[3] || path.join(__dirname, '../resources/win32/code.ico');

if (!fs.existsSync(sourcePath)) {
	console.error(`Error: Source file not found: ${sourcePath}`);
	process.exit(1);
}

async function createIco() {
	try {
		console.log(`Creating Windows .ico file from: ${sourcePath}`);
		console.log(`Output: ${outputPath}`);

		// ICO format requires multiple sizes
		const sizes = [16, 24, 32, 48, 64, 128, 256];

		// Create circular mask for each size
		const createCircularIcon = async (size) => {
			const svgMask = `
				<svg width="${size}" height="${size}">
					<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
				</svg>
			`;

			return await sharp(sourcePath)
				.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
				.composite([
					{
						input: Buffer.from(svgMask),
						blend: 'dest-in'
					}
				])
				.png()
				.toBuffer();
		};

		// Create PNG buffers for each size (circular)
		const images = await Promise.all(
			sizes.map(size => createCircularIcon(size))
		);

		// Create ICO file structure
		// ICO file format: header + directory entries + image data
		const headerSize = 6; // 2 (reserved) + 1 (type) + 1 (count) + 2 (reserved)
		const entrySize = 16; // Each directory entry
		const totalEntrySize = sizes.length * entrySize;

		let offset = headerSize + totalEntrySize;
		const buffers = [];

		// Header
		const header = Buffer.alloc(headerSize);
		header.writeUInt16LE(0, 0); // Reserved
		header.writeUInt16LE(1, 2); // Type (1 = ICO)
		header.writeUInt16LE(sizes.length, 4); // Count

		buffers.push(header);

		// Directory entries
		const entries = [];
		for (let i = 0; i < sizes.length; i++) {
			const entry = Buffer.alloc(entrySize);
			const width = sizes[i] === 256 ? 0 : sizes[i]; // 256 is stored as 0
			const height = sizes[i] === 256 ? 0 : sizes[i]; // 256 is stored as 0

			entry.writeUInt8(width, 0);
			entry.writeUInt8(height, 1);
			entry.writeUInt8(0, 2); // Color palette (0 = no palette)
			entry.writeUInt8(0, 3); // Reserved
			entry.writeUInt16LE(1, 4); // Color planes
			entry.writeUInt16LE(32, 6); // Bits per pixel
			entry.writeUInt32LE(images[i].length, 8); // Image data size
			entry.writeUInt32LE(offset, 12); // Offset to image data

			entries.push(entry);
			offset += images[i].length;
		}

		buffers.push(...entries);
		buffers.push(...images);

		// Combine all buffers
		const icoFile = Buffer.concat(buffers);

		// Write to file
		fs.writeFileSync(outputPath, icoFile);

		console.log(`✓ Successfully created: ${outputPath}`);
		console.log(`	 Includes sizes: ${sizes.join(', ')}`);
	} catch (error) {
		console.error('Error creating .ico file:', error.message);
		process.exit(1);
	}
}

createIco();

